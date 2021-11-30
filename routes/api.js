/* Packages */
const express = require('express');
const createError = require('http-errors');
const multer  = require('multer')
const md5file = require('md5-file');
const rdesc = require('rdesc-parser');
const fs = require('fs');
const zlib = require('zlib');
const hard_dep_types = require('r-constants').essential_dependency_types;
const soft_dep_types = require('r-constants').optional_dependency_types;

/* Local variables */
const upload = multer({ dest: '/tmp/' });
const router = express.Router();

/* Local code */
const tools = require("../src/tools.js");

/* Error generator */
function error_cb(status, next) {
	return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

//Remove file from bucket if there are no more references to it
function delete_file(MD5sum){
	return packages.findOne({MD5sum : MD5sum}).then(function(doc){
		if(doc){
			console.log("Found other references, not deleting file: " + MD5sum);
		} else {
			return bucket.delete(MD5sum).then(function(){
				console.log("Deleted file " + MD5sum);
			});
		}
	});
}

function delete_doc(doc){
	return packages.deleteOne({_id: doc['_id']}).then(function(){
		return delete_file(doc.MD5sum).then(()=>doc);
	});
}

function delete_by_query(query){
	return packages.find(query).project({_id:1, MD5sum:1, Package:1, Version:1}).toArray().then(function(docs){
		return Promise.all(docs.map(delete_doc));
	});
}

router.get('/:user/landing', function(req, res, next) {
  const user = req.params.user;
  const url = 'https://github.com/r-universe/' + user;
  tools.test_if_universe_exists(user).then(function(exists){
    if(exists){
      const accept = req.headers['accept'];
      if(accept && accept.includes('html')){
        res.redirect("/ui");
      } else {
        res.send("Welcome to the " + user + " universe!");
      }
    } else {
      res.status(404).type('text/plain').send("No universe found for user: " + user);
    }
  }).catch(error_cb(400, next));
});

router.get('/:user/packages', function(req, res, next) {
	packages.distinct('Package', {_user : req.params.user}).then(function(x){
		res.send(x);
	}).catch(error_cb(400, next));
});

router.get('/:user/packages/:package', function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package
	packages.distinct('Version', {_user : user, Package : package}).then(function(x){
		res.send(x);
	}).catch(error_cb(400, next));
});

router.get('/:user/packages/:package/:version/:type?/:built?', function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package;
	var query = {_user : user, Package : package};
	if(req.params.version != "any")
		query.Version = req.params.version;
	if(req.params.type)
		query._type = req.params.type;
	if(req.params.built)
		query['Built.R'] = {$regex: '^' + req.params.built};
	packages.find(query).toArray().then(docs => res.send(docs)).catch(error_cb(400, next));
});

router.delete('/:user/packages/:package/:version?/:type?/:built?', function(req, res, next){
	var user = req.params.user;
	var package = req.params.package;
	var query = {_user: req.params.user, Package: req.params.package};
	if(req.params.version && req.params.version != "any")
		query.Version = req.params.version
	if(req.params.type)
		query._type = req.params.type;
	if(req.params.built)
		query['Built.R'] = {$regex: '^' + req.params.built};
	delete_by_query(query).then(docs=>res.send(docs)).catch(error_cb(400, next));
});

function read_description(stream){
	return new Promise(function(resolve, reject) {
		rdesc.parse_stream(stream, function(err, data){
			if(err) reject(err);
			resolve(data);
		});
	});
}

function store_stream_file(stream, key, filename){
	return new Promise(function(resolve, reject) {
		stream.pipe(bucket.openUploadStreamWithId(key, filename, {disableMD5 : false}))
		.on('error', reject)
		.on('finish', function(){
			bucket.find({_id : key}).project({md5:1}).toArray().then(function(docs){
				if(docs.length == 0){
					reject("Upload success but key not found?")
				} else if(docs[0].md5 != key) {
					bucket.delete(key).finally(function(){
						reject("md5 did not match key");
					});
				} else {
					resolve();
				}
			});
		});
	});
}

function crandb_store_file(stream, key, filename){
	return bucket.find({_id : key}).toArray().then(function(docs){
		if(docs.length > 0){
			console.log("Already have this file: " + key);
		} else {
			return(store_stream_file(stream, key, filename));
		}
	});
}

function get_filename(package, version, type){
	const ext = {
		src : '.tar.gz',
		mac : '.tgz',
		win : '.zip'
	}
	return package + "_" + version + ext[type];
}

function validate_description(data, package, version, type){
	if(['src', 'win', 'mac'].indexOf(type) < 0){
		throw "Parameter 'type' must be one of src, win, mac";
	} 
	if(data.Package != package || data.Version != version) {
		throw 'Package name or version does not match upload';
	}
	if(type == 'src' && data.Built) {
		throw 'Source package has a "built" field (binary pkg?)';
	} 
	if((type == 'win' || type == 'mac') && !data.Built) {
		throw 'Binary package is does not have valid Built field';
	} 
	if(type == 'win' && data.Built.OStype != 'windows') {
		throw 'Windows Binary package has unexpected OStype:' + data.Built.OStype;
	} 
	if(type == 'mac' && data.Built.OStype != 'unix') {
		throw 'MacOS Binary package has unexpected OStype:' + data.Built.OStype;
	} 
	if(type == 'mac' && data.Built.Platform && !data.Built.Platform.match('apple')) {
		//Built.Platform is missing for binary pkgs without copiled code
		throw 'MacOS Binary package has unexpected Platform:' + data.Built.Platform;
	}
}

function filter_keys(x, regex){
	var out = {};
	Object.keys(x).filter(key=>key.match(regex)).forEach(key=>out[key.replace(regex, "").toLowerCase()]=x[key]);
	return out;
}

function from_base64_gzip(str){
	if(!str) return str;
	let input = str.replace(/-/g, '+').replace(/_/g, '/'); //also support base64url format
	let buff = Buffer.from(str, 'base64');
	let json = zlib.unzipSync(buff).toString('utf-8');
	return JSON.parse(json);
}

function parse_builder_fields(x){
	var builder = filter_keys(x, /^builder-/gi);
	if(builder.sysdeps)
		builder.sysdeps = rdesc.parse_dep_string(builder.sysdeps);
	builder.vignettes = from_base64_gzip(builder.vignettes);
	builder.commit = from_base64_gzip(builder.commit);
	builder.maintainer = from_base64_gzip(builder.maintainer) || {};
	/* For backward compatibility, remove later */
	builder.maintainerlogin = builder.maintainerlogin || builder.maintainer.login;
	return builder;
}

function merge_dependencies(x){
	var hard_deps = [];
	var soft_deps = [];
	Object.keys(x).forEach(function(key) {
		if(hard_dep_types.includes(key)){
			hard_deps = hard_deps.concat(x[key].map(function(y){y.role = key; return y;}));
			delete x[key];
		}
		if(soft_dep_types.includes(key)){
			soft_deps = soft_deps.concat(x[key].map(function(y){y.role = key; return y;}));
			delete x[key];
		}
	});
	x['_hard_deps'] = hard_deps;
	x['_soft_deps'] = soft_deps;
	return x;
}

function parse_major_version(built){
	if(!built || !built.R)
		throw "Package is missing Built.R field. Cannot determine binary version";
	var r_major_version = built.R.match(/^\d\.\d+/);
	if(!r_major_version)
		throw "Failed to find R version from Built.R field: " + str;
	return r_major_version;
}

function get_repo_owner(description){
  var url = description['_builder'].upstream || "";
  if(url.indexOf("github.com/") > 0){
    return url.split('/').at(-2).toLowerCase();
  }
}

router.put('/:user/packages/:package/:version/:type/:md5', function(req, res, next){
	var user = req.params.user;
	var package = req.params.package;
	var version = req.params.version;
	var type = req.params.type;
	var md5 = req.params.md5;
	var query = {_user : user, _type : type, Package : package};
	var filename = get_filename(package, version, type);
	crandb_store_file(req, md5, filename).then(function(){
		return read_description(bucket.openDownloadStream(md5)).then(function(description){
			description['_user'] = user;
			description['_type'] = type;
			description['_file'] = filename;
			description['_published'] = new Date();
			description['_builder'] = parse_builder_fields(req.headers) || {};
			description['_owner'] = get_repo_owner(description);
			description['_selfowned'] = description['_owner'] === user;
			description['_registered'] = (description['_builder'].registered !== "false");
			description['MD5sum'] = md5;
			description = merge_dependencies(description);
			validate_description(description, package, version, type);
			if(type != "src"){
				query['Built.R'] = {$regex: '^' + parse_major_version(description.Built)};
			}
			return packages.findOneAndReplace(query, description, {upsert: true, returnOriginal: true}).then(function(result) {
				var original = result.value;
				if(original){
					return delete_file(original['MD5sum']);
				}
			}).then(function(){
				if(type === 'src'){
					return packages.deleteMany({_type : 'failure', _user : user, Package : package});
				}
			}).then(() => res.send(description));	
		}).catch(function(e){
			return delete_file(md5).then(()=>{throw e});
		});
	}).catch(error_cb(400, next));
});

router.post('/:user/packages/:package/:version/failure', upload.none(), function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var version = req.params.version;
  var builder = parse_builder_fields(req.body);
  var maintainer = `${builder.maintainer.name} <${builder.maintainer.email}>`;
  var query = {_type : 'failure', _user : user, Package : package};
  var description = {...query, Version: version, Maintainer: maintainer, _builder: builder, _published: new Date()};
  description['_owner'] = get_repo_owner(description);
  description['_selfowned'] = description['_owner'] === user;
  description['_registered'] = (description['_builder'].registered !== "false");
  packages.findOneAndReplace(query, description, {upsert: true})
    .then(() => res.send(description))
    .catch(error_cb(400, next))
});

router.post('/:user/packages/:package/:version/:type', upload.fields([{ name: 'file', maxCount: 1 }]), function(req, res, next) {
	if(!req.files.file || !req.files.file[0]){
		return next(createError(400, "Missing parameter 'file' in upload"));
	}
	var user = req.params.user;
	var package = req.params.package;
	var version = req.params.version;
	var type = req.params.type;
	var query = {_user : user, _type : type, Package : package};
	var filepath = req.files.file[0].path;
	var filename = req.files.file[0].originalname;
	var md5 = md5file.sync(filepath);
	var stream = fs.createReadStream(filepath);
	crandb_store_file(stream, md5, filename).then(function(){
		return read_description(bucket.openDownloadStream(md5)).then(function(description){
			description['_user'] = user;
			description['_type'] = type;
			description['_file'] = filename;
			description['_published'] = new Date();
			description['_builder'] = parse_builder_fields(req.body);
			description['_owner'] = get_repo_owner(description);
			description['_selfowned'] = description['_owner'] === user;
			description['_registered'] = (description['_builder'].registered !== "false");
			description['MD5sum'] = md5;
			description = merge_dependencies(description);
			validate_description(description, package, version, type);
			if(type != "src"){
				query['Built.R'] = {$regex: '^' + parse_major_version(description.Built)};
			}
			return packages.findOneAndReplace(query, description, {upsert: true, returnOriginal: true}).then(function(result) {
				var original = result.value;
				if(original){
					return delete_file(original['MD5sum']);
				}
			}).then(function(){
				if(type === 'src'){
					return packages.deleteMany({_type : 'failure', _user : user, Package : package});
				}
			}).then(() => res.send(description));
		}).catch(function(e){
			return delete_file(md5).then(()=>{throw e});
		});
	}).catch(error_cb(400, next)).then(function(){
		fs.unlink(filepath, () => console.log("Deleted tempfile: " + filepath));
	});
});

module.exports = router;
