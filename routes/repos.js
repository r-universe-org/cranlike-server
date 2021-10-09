/* Packages */
const express = require('express');
const createError = require('http-errors');
const zlib = require('zlib');
const tar = require('tar-stream');
const mime = require('mime');
const router = express.Router();

/* Fields included in PACKAGES indices */
/* To do: once DB is repopulated, we can remove Imports, Suggests, etc in favor of _dependencies */
const pkgfields = {_id: 1, _hard_deps: 1, _soft_deps: 1, Package: 1, Version: 1, Depends: 1, Suggests: 1, License: 1,
	NeedsCompilation: 1, Imports: 1, LinkingTo: 1, Enhances: 1, License_restricts_use: 1,
	OS_type: 1, Priority: 1, License_is_FOSS: 1, Archs: 1, Path: 1, MD5sum: 1, Built: 1};

function error_cb(status, next) {
	return function(err) {
		next(createError(status, err));
	}
}

function dep_to_string(x){
	if(x.package && x.version){
		return x.package + " (" + x.version + ")";
	} else if(x.package) {
		return x.package
	} else {
		return x;
	}
}

function unpack_deps(x){
	var hard_deps = x['_hard_deps'] || [];
	var soft_deps = x['_soft_deps'] || [];
	var alldeps = hard_deps.concat(soft_deps);
	var deptypes = new Set(alldeps.map(dep => dep.role));
	deptypes.forEach(function(type){
		x[type] = alldeps.filter(dep => dep.role == type);
	});
	delete x['_hard_deps'];
	delete x['_soft_deps'];
	return x;
}

function doc_to_dcf(doc){
	var x = unpack_deps(doc);
	delete x['_id'];
	let keys = Object.keys(x);
	return keys.map(function(key){
		let val = x[key];
		if(Array.isArray(val))
			val = val.map(dep_to_string).join(", ");
		else if(key == 'Built')
			val = "R " + Object.values(val).join("; ");
		return key + ": " + val.replace(/\s/gi, ' ');
	}).join("\n") + "\n\n";
}

function doc_to_ndjson(x){
	return JSON.stringify(x) + '\n';
}

function doc_to_filename(x){
	const ext = {
		src: ".tar.gz",
		win: ".zip",
		mac: ".tgz"
	};
	return x.Package + "_" + x.Version + ext[x['_type']] + '\n';
}

function etagify(x){
	return 'W/"' +  x + '"';
}

function qf(x){
	if(x._user == ":any"){
		delete x._user;
	}
	return x;
}

function packages_index(query, format, req, res, next){
	var cursor = packages.find(query).project(pkgfields).sort({"_id" : -1});
	cursor.hasNext().then(function(has_any_data){
		if(has_any_data){
			return cursor.next(); //promise to read 1 record
		}
	}).then(function(doc){
		if(doc){
			var etag = etagify(doc['_id']);
			/* Cache disabled until we solve _id bug */
			if(0 && etag === req.header('If-None-Match')){
				cursor.close();
				res.status(304).send();
				return; //DONE!
			} else {
				cursor.rewind();
				res.set('ETag', etag);
			}
		}
		res.set('Cache-Control', 'no-cache');
		if(!format){
			cursor
				.transformStream({transform: doc_to_dcf})
				.pipe(res.type('text/plain'));
		} else if(format == 'gz'){
			cursor
				.transformStream({transform: doc_to_dcf})
				.pipe(zlib.createGzip())
				.pipe(res.type('application/x-gzip'));
		} else if(format == 'json'){
			cursor
				.transformStream({transform: doc_to_ndjson})
				.pipe(res.type('text/plain'));
		} else {
			next(createError(404, 'Unknown PACKAGES format: ' + format));
		}
	}).catch(error_cb(400, next));
}

function html_index(query, res){
	packages
		.find(query)
		.project({_id:0, Package:1, Version:1, _type:1})
		.transformStream({transform: doc_to_filename})
		.pipe(res.type('text/plain'));
}

function count_by_user(){
	return packages.aggregate([
		{$group:{_id: "$_user", count: { $sum: 1 }}}
	])
	.project({_id: 0, user: "$_id", count: 1})
	.transformStream({transform: doc_to_ndjson});
}

function count_by_type(user){
	return packages.aggregate([
		{$match: qf({_user: user})},
		{$group:{_id: "$_type", count: { $sum: 1 }}}
	])
	.project({_id: 0, type: "$_id", count: 1})
	.transformStream({transform: function(x){
		const dirname = {
			src : 'src/contrib',
			win : 'bin/windows/contrib',
			mac : 'bin/macosx/contrib/'
		};
		x.path = dirname[x.type];
		return doc_to_ndjson(x);
	}});
}

function count_by_built(user, type){
	return packages.aggregate([
		{$match: {_user: user, _type : type}},
		{$group:{_id: {R: "$Built.R", Platform: "$Built.Platform"}, count: { $sum: 1 }}}
	])
	.project({_id: 0, R: "$_id.R", Platform:"$_id.Platform", count: 1})
	.transformStream({transform: doc_to_ndjson});
}

function send_binary(query, content_type, req, res, next){
	packages.findOne(query, {project: {MD5sum: 1, Redirect: 1}}).then(function(docs){
		if(!docs){
			next(createError(404, 'Package not found'));
		} else if(docs.Redirect) {
			res.status(301).redirect(docs.Redirect);
		} else {
			var etag = etagify(docs.MD5sum);
			if(etag === req.header('If-None-Match')){
				res.status(304).send()
			} else {
				bucket.find({_id: docs.MD5sum}, {limit:1}).toArray(function(err, x){
					if (err || !x[0]){
						return next(createError(500, "Failed to locate file in gridFS: " + docs.MD5sum));
					}
					bucket.openDownloadStream(docs.MD5sum).pipe(
						res.type(content_type).set("ETag", etag).set('Content-Length', x[0].length)
					);
				});
			}
		}
	}).catch(error_cb(400, next));	
}

function send_extracted_file(query, filename, req, res, next){
  packages.findOne(query, {project: {MD5sum: 1, Redirect: 1}}).then(function(docs){
    if(!docs){
      next(createError(404, 'Package not found'));
    } else if(docs.Redirect) {
      res.status(301).redirect(docs.Redirect);
    } else {
      var etag = etagify(docs.MD5sum);
      if(etag === req.header('If-None-Match')){
        res.status(304).send()
      } else {
        bucket.find({_id: docs.MD5sum}, {limit:1}).toArray(function(err, x){
          if (err || !x[0]){
            return next(createError(500, "Failed to locate file in gridFS: " + docs.MD5sum));
          }
          var dolist = filename instanceof RegExp;
          var matches = [];
          var extract = tar.extract();
          var hassent = false;
          extract.on('entry', function(header, stream, cb) {
            stream.on('end', cb);
            if(!dolist && !hassent && header.name === filename){
              hassent = true;
              stream.pipe(
                res.type(mime.getType(filename) || 'text/plain').set("ETag", etag).set('Content-Length', header.size)
              );
            } else {
              if(header.name && dolist){
                let m = header.name.match(filename);
                if(m && m.length){
                  matches.push(m.pop());
                }
              }
              stream.resume();
            }
          });
          extract.on('finish', function(){
            if(dolist){
              res.send(matches);
            } else if(!hassent) {
              next(createError(404, "No such file: " + filename));
            }
          });
          bucket.openDownloadStream(docs.MD5sum).pipe(zlib.createGunzip()).pipe(extract);
        });
      }
    }
  }).catch(error_cb(400, next));
}

function find_by_user(_user, _type){
	var out = {};
	if(_user != ':any')
		out._user = _user;
	if(_type)
		out_type = _type;
	return out;
}

/* Use negative match, because on packages without compiled code Built.Platform is empty */
function arch_to_built(xcode){
  return (xcode && xcode.match("arm64")) ? {$not : /x86_64/} : {$not : /aarch64/ };
}

/* Copied from api.js */
router.get('/', function(req, res, next) {
	count_by_user().pipe(res);
});

router.get('/:user', function(req, res, next) {
	count_by_type(req.params.user).pipe(res);
});

router.get('/:user/src', function(req, res, next) {
	res.redirect('/' + req.params.user + '/src/contrib');
});

router.get('/:user/bin', function(req, res, next) {
	count_by_type(req.params.user).pipe(res);
});

router.get('/:user/bin/windows', function(req, res, next) {
	res.redirect('/' + req.params.user + '/bin/windows/contrib');
});

router.get('/:user/bin/macosx', function(req, res, next) {
	res.redirect('/' + req.params.user + '/bin/macosx/contrib');
});

/* CRAN-like index for source packages */
router.get('/:user/src/contrib/PACKAGES\.:ext?', function(req, res, next) {
	packages_index(qf({_user: req.params.user, _type: 'src'}), req.params.ext, req, res, next);
});

router.get('/:user/src/contrib/', function(req, res, next) {
	packages_index(qf({_user: req.params.user, _type: 'src'}), 'json', req, res, next);
});

/* CRAN-like index for Windows packages */
router.get('/:user/bin/windows/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
	var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}});
	packages_index(query, req.params.ext, req, res, next);
});

router.get('/:user/bin/windows/contrib/:built/', function(req, res, next) {
	var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}});
	packages_index(query, 'json', req, res, next);
});

/* CRAN-like index for MacOS packages */
router.get('/:user/bin/macosx/:xcode?/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
	var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}});
	query['Built.Platform'] = arch_to_built(req.params.xcode);
	packages_index(query, req.params.ext, req, res, next);
});

router.get('/:user/bin/macosx/:xcode?/contrib/:built/', function(req, res, next) {
	var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}});
	query['Built.Platform'] = arch_to_built(req.params.xcode);
	packages_index(query, 'json', req, res, next);
});

/* Index available R builds for binary pkgs */
router.get('/:user/bin/windows/contrib', function(req, res, next) {
	count_by_built(req.params.user, 'win').pipe(res);
});

router.get('/:user/bin/macosx/:xcode?/contrib', function(req, res, next) {
	count_by_built(req.params.user, 'mac').pipe(res);
});

/* Download package files */
router.get('/:user/src/contrib/:pkg.tar.gz', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = qf({_user: req.params.user, _type: 'src', Package: pkg[0], Version: pkg[1]});
	send_binary(query, 'application/x-gzip', req, res, next);
});

router.get('/:user/bin/windows/contrib/:built/:pkg.zip', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built},
		Package: pkg[0], Version: pkg[1]});
	send_binary(query, 'application/zip', req, res, next);
});

router.get('/:user/bin/macosx/:xcode?/contrib/:built/:pkg.tgz', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built},
		Package: pkg[0], Version: pkg[1]});
	query['Built.Platform'] = arch_to_built(req.params.xcode);
	send_binary(query, 'application/x-gzip', req, res, next);
});

/* For now articles are only vignettes */
router.get('/:user/articles', function(req, res, next){
  var query = qf({_user: req.params.user, _type: 'src', '_builder.vignettes' : { $exists: true }});
  packages.distinct('Package', query).then(function(x){
    res.send(x);
  }).catch(error_cb(400, next));
});

/* Extract single files */
router.get('/:user/articles/:pkg/:file?', function(req, res, next){
  var pkg = req.params.pkg;
  var query = qf({_user: req.params.user, _type: 'src', Package: pkg});
  var prefix = pkg + "/inst/doc/";
  var filename = req.params.file ? (prefix + req.params.file) : new RegExp('^' + prefix + "(.+)$");
  send_extracted_file(query, filename, req, res, next);
});

router.get("/:user/stats/vignettes", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 200;
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src', '_builder.vignettes' : {$exists: true}})},
    {$sort : {'_builder.timestamp' : -1}},
    {$limit : limit},
    {$project: {
      _id: 0,
      package: '$Package',
      version: '$Version',
      maintainer: '$Maintainer',
      universe: '$_user',
      pkglogo: '$_builder.pkglogo',
      upstream: '$_builder.upstream',
      maintainerlogin: '$_builder.maintainerlogin',
      published: '$_builder.timestamp',
      builddate: '$_builder.date',
      registered: '$_builder.registered',
      vignette: '$_builder.vignettes'
    }},
    {$unwind: '$vignette'}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Public aggregated data (these support :any users)*/
router.get('/:user/stats/descriptions', function(req, res, next) {
	var query = qf({_user: req.params.user, _type: 'src', '_builder.registered' : {$ne: 'false'}});
	var cursor = packages.find(query).sort({"_id" : -1}).project({_id:0, _type:0});
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

/* Failures(these support :any users)*/
router.get('/:user/stats/failures', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'failure'});
  var cursor = packages.find(query).sort({"_id" : -1}).project({_id:0, _type:0});
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Public aggregated data (these support :any users)*/
router.get('/:user/stats/checks', function(req, res, next) {
	var limit = parseInt(req.query.limit) || 500;
	var query = qf({_user: req.params.user});
	if(req.query.maintainer)
		query.Maintainer = {$regex: req.query.maintainer, $options: 'i'};
	var cursor = packages.aggregate([
		{$match: query},
		{$group : {
			_id : { package:'$Package', version:'$Version', user: '$_user', maintainer: '$Maintainer'},
			timestamp: { $max : "$_builder.timestamp" },
			os_restriction: { $addToSet: '$OS_type'},
			runs : { $addToSet: { type: "$_type", builder: "$_builder", built: '$Built', date:'$_published'}}
		}},
		/* NB: sort+limit requires buffering, maybe not a good idea? */
		{$sort : {timestamp : -1}},
		{$limit : limit},
		{$project: {
			_id: 0, user: '$_id.user', maintainer:'$_id.maintainer', package: '$_id.package', version:'$_id.version', runs:1, os_restriction:{ $first: "$os_restriction" }}
		}
	]);
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

router.get("/:user/stats/maintainers", function(req, res, next) {
	var cursor = packages.aggregate([
		{$match: qf({_user: req.params.user, _type: 'src', '_builder.registered' : {$ne: 'false'}})},
		{$set: { email: { $regexFind: { input: "$Maintainer", regex: /^(.+)<(.*)>$/ } } } },
		{$project: {
			_id: 0,
			package: '$Package',
			user: '$_user',
			login: '$_builder.maintainerlogin',
			registered: '$_builder.registered',
			name: { $trim: { input: { $first: '$email.captures'}}},
			email: { $arrayElemAt: ['$email.captures',1]}
		}},
		{$unwind: '$email'},
		{$group: {
			_id : '$email',
			name : { $first: '$name'},
			login : { $addToSet: '$login'}, //login can be null
			packages : { $addToSet: {
				package: '$package',
				registered: '$registered',
				user: '$user'
			}}
		}},
		{$project: {_id: 0, name: 1, login: { '$first' : '$login'}, email: '$_id', packages: '$packages'}},
		{$sort:{ email: 1}}
	]);
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

router.get("/:user/stats/organizations", function(req, res, next) {
	var cursor = packages.aggregate([
		{$match: qf({_user: req.params.user, _type: 'src', '_builder.registered' : {$ne: 'false'}})},
		{$set: { email: { $regexFind: { input: "$Maintainer", regex: /^(.+)<(.*)>$/ } } } },
		{$project: {
			_id: 0,
			package: '$Package',
			user: '$_user',
			name: { $trim: { input: { $first: '$email.captures'}}},
			email: { $arrayElemAt: ['$email.captures',1]}
		}},
		{$group: {
			_id : '$user',
			packages : { $addToSet: '$package'},
			maintainers: { $addToSet: '$email'}
		}},
		{$project: {_id: 0, organization: '$_id', packages: 1, maintainers: 1}}
	]);
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

router.get("/:user/stats/revdeps", function(req, res, next) {
	var cursor = packages.aggregate([
		{$match: qf({_user: req.params.user, _type: 'src', '_builder.registered' : {$ne: 'false'}})},
		{$project: {_id: 0, user: '$_user', package: '$Package', dependencies: {$concatArrays: ['$_hard_deps', '$_soft_deps']}}},
		{$unwind: '$dependencies'},
		{$group: {
			_id : '$dependencies.package',
			revdeps : { $addToSet: 
				{user: '$user', package: '$package', role: '$dependencies.role', version: '$dependencies.version'}}
		}},
		{$project: {_id: 0, package: '$_id', revdeps: '$revdeps'}},
		{$sort:{ package: 1}}
	]);
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

router.get("/:user/stats/sysdeps", function(req, res, next) {
	var cursor = packages.aggregate([
		{$match: qf({_user: req.params.user, _type: 'src'})},
		{$project: {_id: 0, user: '$_user', package: '$Package', sysdeps: '$_builder.sysdeps.package'}},
		{$unwind: '$sysdeps'},
		{$group: {
			_id : '$sysdeps',
			packages : { $addToSet: {user: '$user', package:'$package'}}
		}},
		{$project: {_id: 0, sysdep: '$_id', packages: '$packages'}},
		{$sort:{ sysdep: 1}}
	])
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

/* Operations below do not support :any user because they are very heavy */
router.get("/:user/stats/rundeps", function(req, res, next) {
	var cursor = packages.aggregate([
		{$match: {_user: req.params.user, _type: 'src'}},
		{ $graphLookup: {
			from: "packages",
			startWith: "$_hard_deps.package",
			connectFromField: "_hard_deps.package",
			connectToField: "Package",
			as: "DependencyHierarchy"
		}},
		{ $project: {Package: 1, rundeps: {'$setUnion': ['$DependencyHierarchy.Package']}}}
	]);
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

router.get("/:user/stats/checkdeps", function(req, res, next) {
	var cursor = packages.aggregate([
		{$match: {_user: req.params.user, _type: 'src'}},
		{ $project: {_id: 0, Package: 1, deps: {$concatArrays: ['$_hard_deps', '$_soft_deps']}}},
		{ $graphLookup: {
			from: "packages",
			startWith: "$deps.package",
			connectFromField: "_hard_deps.package",
			connectToField: "Package",
			as: "DependencyHierarchy"
		}},
		{ $project: {Package: 1, checkdeps: {'$setUnion': ['$DependencyHierarchy.Package']}}}
	]);
	cursor.hasNext().then(function(){
		cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
	}).catch(error_cb(400, next));
});

module.exports = router;
