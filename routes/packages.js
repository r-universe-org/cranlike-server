/* Packages */
const express = require('express');
const createError = require('http-errors');
const multer  = require('multer')
const md5file = require('md5-file');
const rdesc = require('rdesc-parser');
const fs = require('fs');
const zlib = require('zlib');
const tar = require('tar-stream');
const dependency_types = require('r-constants').dependency_types;

/* Local variables */
const multerstore = multer({ dest: '/tmp/' });
const router = express.Router();

/* Local code */
const tools = require("../src/tools.js");
const match_macos_arch = tools.match_macos_arch;

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

/*
router.get('/:user/packages/:package', function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package
  packages.distinct('Version', {_user : user, Package : package}).then(function(x){
    res.send(x);
  }).catch(error_cb(400, next));
});
*/

router.get('/:user/packages/:package/:version?/:type?/:built?', function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var query = {_user : user, Package : package};
  if(req.params.version && req.params.version != "any")
    query.Version = req.params.version;
  if(req.params.type)
    query._type = req.params.type;
  if(req.params.built)
    query['Built.R'] = {$regex: '^' + req.params.built};
  packages.find(query).sort({"Built.R" : -1}).toArray().then(docs => res.send(docs)).catch(error_cb(400, next));
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

// Some packages have X-schema.org fields in description, which mongo does not accept.
function sanitize_keys(data){
  let keys = Object.keys(data).filter(key => key.includes('.'));
  for (const x of keys){
    console.log(`Deleting description field ${x} (dots in names not allowed)`)
    delete data[x];
  }
  return data;
}

function read_description(stream){
  return new Promise(function(resolve, reject) {
    rdesc.parse_stream(stream, function(err, data){
      if(err) {
        reject(err);
      } else {
        resolve(sanitize_keys(data));
      }
    });
  });
}

function store_stream_file(stream, key, filename){
  return new Promise(function(resolve, reject) {
    var upload = bucket.openUploadStreamWithId(key, filename);
    var pipe = stream.pipe(upload);
    pipe.on('error', function(err){
      console.log("Error in openUploadStreamWithId()" + err);
      /* Clear possible orphaned chunks, then reject */
      chunks.deleteMany({files_id: key}).finally(function(e){
        reject("Error in openUploadStreamWithId(): " + err);
      });
    });
    pipe.on('finish', function(){
      db.command({filemd5: key, root: "files"}).then(function(check){
        if(check.md5 != key) {
          bucket.delete(key).finally(function(){
            console.log("md5 did not match key");
            reject("md5 did not match key");
          });
        } else {
          resolve({_id: key, length: upload.length});
        }
      });
    });
  });
}

function crandb_store_file(stream, key, filename){
  return bucket.find({_id : key}, {limit:1}).next().then(function(x){
    if(x){
      /* Replace blob just in case the old one is corrupt */
      console.log(`Already have file ${key} (${filename}). Deleting old one.`);
      return bucket.delete(key);
    }
  }).then(function(){
    return store_stream_file(stream, key, filename);
  });
}

function get_filename(package, version, type, distro){
  const ext = {
    src : '.tar.gz',
    mac : '.tgz',
    win : '.zip',
    wasm: '.tgz',
    linux: `-${distro || "linux"}.tar.gz`
  }
  return package + "_" + version + ext[type];
}

function validate_description(data, package, version, type){
  if(['src', 'win', 'mac', 'linux', 'wasm'].indexOf(type) < 0){
    throw "Parameter 'type' must be one of src, win, mac, linux, wasm";
  } 
  if(data.Package != package || data.Version != version) {
    throw 'Package name or version does not match upload';
  }
  if(type == 'src' && data.Built) {
    throw 'Source package has a "built" field (binary pkg?)';
  } 
  if((type == 'win' || type == 'mac' || type == 'linux' || type == 'wasm') && !data.Built) {
    throw 'Binary package does not have valid Built field';
  } 
  if(type == 'win' && data.Built.OStype != 'windows') {
    throw 'Windows Binary package has unexpected OStype:' + data.Built.OStype;
  } 
  if(type == 'mac' && data.Built.OStype != 'unix') {
    throw 'MacOS Binary package has unexpected OStype:' + data.Built.OStype;
  }
  if(type == 'wasm' && data.Built.OStype != 'unix') {
    throw 'WASM Binary package has unexpected OStype:' + data.Built.OStype;
  }
  if(type == 'linux' && data.Built.Platform && data.Built.Platform != 'x86_64-pc-linux-gnu') {
    //Built.Platform is missing for binary pkgs without copiled code
    throw 'Linux Binary package has unexpected Platform:' + data.Built.Platform;
  }
  if(type == 'mac' && data.Built.Platform && !data.Built.Platform.match('apple')) {
    //Built.Platform is missing for binary pkgs without copiled code
    throw 'MacOS Binary package has unexpected Platform:' + data.Built.Platform;
  }
  if(type !== 'failure' && data._status === undefined) {
    throw 'Submission does not have a "status" field';
  }
  if(!data._commit || !data._commit.id){
    throw 'No commit data found in builder metadata';
  }
  if(!data._maintainer || !data._maintainer.email){
    throw 'No maintainer data found in builder metadata';
  }
  if(data._registered === undefined){
    throw 'No registered field found in builder headers';
  }
  //workaround for cross compiled packages with compiled code
  if(type == 'wasm' && data.Built.Platform){
    data.Built.Platform = 'emscripten';
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
  builder.commit = from_base64_gzip(builder.commit) || {};
  builder.maintainer = from_base64_gzip(builder.maintainer) || {};
  builder.registered = builder.registered !== "false";
  return builder;
}

function merge_dependencies(x){
  var deps = [];
  dependency_types.forEach(function(key){
    if(x[key]){
      deps = deps.concat(x[key].map(function(y){y.role = key; return y;}));
    }
    delete x[key];
  });
  x['_dependencies'] = deps;
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

function get_repo_owner(url){
  const re = new RegExp('.*://([a-z]+).*/([^/]*)/.*')
  const match = (url || "").toLowerCase().match(re);
  if(match){
    return match[1] == 'github' ? match[2] : `${match[1]}-${match[2]}`;
  }
}

function get_created(x){
  if(x.Built && x.Built.Date){
    return new Date(x.Built.Date); //binary pkg date
  } else if(x.Packaged && x.Packaged.Date){
    return new Date(x.Packaged.Date); //source pkg date
  } else {
    return new Date(); //neither; only for 'error' uploads
  }
}

function calculate_score(description){
  var score = 3 * description['_usedby'];
  if(description._cranurl){
    score += 5;
    if(description._crandownloads){
      score += Math.min(500, description._crandownloads/1000);
    }
  }
  if(description._mentions)
    score += Math.min(300, description._mentions * 3 || 0);
  if(description._stars)
    score += (description._stars || 0);
  if(Array.isArray(description._updates))
    score += (description._updates.length || 0)
  if(typeof description._contributions === 'object')
    score += Object.keys(description._contributions).length;
  return 1 + Math.log10(Math.max(1, score));
}

function is_indexed(description){
  var universe = description._user;
  if(description['_registered'] === false)
    return false; // never index remotes
  if((description.URL || "").toLowerCase().includes(`${universe}.r-universe.dev`))
    return true; // package names this universe in description
  var owner = description._realowner || description._owner;
  return universe == owner;
}

function set_universes(description){
  var universes = [description._user];
  if(is_indexed(description)){
    if(description._maintainer.login){
      universes.push(description._maintainer.login);
    }
    if(description._devurl){
      universes.push(get_repo_owner(description._devurl));
    }
  }
  description['_universes'] = [...new Set(universes)]; //unique values
}

function is_self_owned(description){
  var user = description._user;
  if(user === 'cran'){
    return false; //mirror only packages
  }
  if(description._owner === user || description._maintainer.login === user || user === 'ropensci'){
    return true;
  }
  var URL = description.URL || "";
  return URL.includes(`${user}.r-universe.dev`);
}

function add_meta_fields(description, meta){
  for (const [key, value] of Object.entries(meta)) {
    description[`_${key}`] = value;
  }
}

router.put('/:user/packages/:package/:version/:type/:md5', function(req, res, next){
  var user = req.params.user;
  var package = req.params.package;
  var version = req.params.version;
  var type = req.params.type;
  var md5 = req.params.md5;
  var query = {_user : user, _type : type, Package : package};
  var builder = parse_builder_fields(req.headers) || {};
  var filename = get_filename(package, version, type, builder.distro);
  crandb_store_file(req, md5, filename).then(function(filedata){
    if(type == 'src'){
      var p1 = packages.countDocuments({_type: 'src', _indexed: true, '_rundeps': package});
      var p2 = extract_json_metadata(bucket.openDownloadStream(md5), package);
      return Promise.all([filedata, p1, p2]);
    } else {
      return [filedata];
    }
  }).then(function(metadata){
    //console.log(`Successfully stored file ${filename} with ${runrevdeps} runreveps`);
    return read_description(bucket.openDownloadStream(md5)).then(function(description){
      const filedata = metadata[0];
      description['MD5sum'] = md5;
      description['_user'] = user;
      description['_type'] = type;
      description['_file'] = filename;
      description['_fileid'] = filedata['_id'];
      description['_filesize'] = filedata.length;
      description['_created'] = get_created(description);
      description['_published'] = new Date();
      add_meta_fields(description, builder);
      merge_dependencies(description);
      validate_description(description, package, version, type);
      description['_owner'] = get_repo_owner(description._upstream);
      description['_selfowned'] = is_self_owned(description);
      if(type == "src"){
        description['_usedby'] = metadata[1];
        add_meta_fields(description, metadata[2]); //contents.json
        description['_score'] = calculate_score(description);
        description['_indexed'] = is_indexed(description);
        description['_nocasepkg'] = package.toLowerCase();
        set_universes(description);
      } else {
        query['Built.R'] = {$regex: '^' + parse_major_version(description.Built)};
      }
      if(type == 'mac' && description.Built.Platform){
        query['Built.Platform'] = match_macos_arch(description.Built.Platform);
      }
      return packages.findOneAndDelete(query).then(function(original) {
        // This callback API changed in recent mongo-nodejs
        if(original && original['MD5sum'] !== md5){
          return delete_file(original['MD5sum']);
        }
      }).then(function(x){
        return packages.insertOne(description);
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

router.post('/:user/packages/:package/:version/update', multerstore.none(), function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var version = req.params.version;
  var query = {_type : 'src', _user : user, Package : package, Version: version};
  var payload = req.body;
  Promise.resolve().then(function(){
    var fields = Object.keys(payload);
    if(!fields.includes("$set") && !fields.includes("$unset"))
      throw "Object must contain either $set or $unset operation";
    return packages.findOneAndUpdate(query, payload).then(doc => res.send(doc.value));
  }).catch(error_cb(400, next));
});

router.post('/:user/packages/:package/:version/failure', multerstore.none(), function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var version = req.params.version;
  var builder = parse_builder_fields(req.body);
  var maintainer = `${builder.maintainer.name} <${builder.maintainer.email}>`;
  var query = {_type : 'failure', _user : user, Package : package};
  var description = {...query, Version: version, Maintainer: maintainer, _published: new Date()};
  add_meta_fields(description, builder);
  description['_created'] = new Date();
  description['_owner'] = get_repo_owner(description._upstream);
  description['_selfowned'] = description._owner === user;
  description['_universes'] = [user]; //show failures in dashboard
  description['_nocasepkg'] = package.toLowerCase();
  packages.findOneAndReplace(query, description, {upsert: true})
    .then(() => res.send(description))
    .catch(error_cb(400, next))
});

router.post('/:user/packages/:package/:version/:type', multerstore.fields([{ name: 'file', maxCount: 1 }]), function(req, res, next) {
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
  var builder = parse_builder_fields(req.body);
  var stream = fs.createReadStream(filepath);
  crandb_store_file(stream, md5, filename).then(function(filedata){
    if(type == 'src'){
      var p1 = packages.countDocuments({_type: 'src', _indexed: true, '_rundeps': package});
      var p2 = extract_json_metadata(bucket.openDownloadStream(md5), package);
      return Promise.all([filedata, p1, p2]);
    } else {
      return [filedata];
    }
  }).then(function(metadata){
    return read_description(bucket.openDownloadStream(md5)).then(function(description){
      const filedata = metadata[0];
      description['MD5sum'] = md5;
      description['_user'] = user;
      description['_type'] = type;
      description['_file'] = filename;
      description['_fileid'] = filedata['_id'];
      description['_filesize'] = filedata.length;
      description['_created'] = get_created(description);
      description['_published'] = new Date();
      add_meta_fields(description, builder);
      merge_dependencies(description);
      validate_description(description, package, version, type);
      description['_owner'] = get_repo_owner(description._upstream);
      description['_selfowned'] = is_self_owned(description);
      if(type == "src"){
        description['_usedby'] = metadata[1];
        add_meta_fields(description, metadata[2]); //contents.json
        description['_score'] = calculate_score(description);
        description['_indexed'] = is_indexed(description);
        description['_nocasepkg'] = package.toLowerCase();
        set_universes(description);
      } else {
        query['Built.R'] = {$regex: '^' + parse_major_version(description.Built)};
      }
      if(type == 'mac' && description.Built.Platform){
        query['Built.Platform'] = match_macos_arch(description.Built.Platform);
      }
      return packages.findOneAndDelete(query).then(function(original) {
        // This callback API changed in recent mongo-nodejs
        if(original && original['MD5sum'] !== md5){
          return delete_file(original['MD5sum']);
        }
      }).then(function(x){
        return packages.insertOne(description);
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

/* HTTP PATCH does not require authentication, so this API is public */
router.patch('/:user/packages/:package/:version/:type', function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var version = req.params.version;
  var type = req.params.type || 'src'
  var query = {_user : user, _type : type, Package : package, Version: version};
  packages.find(query).next().then(function(doc){
    if(!doc) {
      throw `Failed to find package ${package} ${version} in ${user}`;
    }
    const now = new Date();
    /* Try to prevent hammering of the GH API. However note that the _rebuild_pending field
       automatically disappears upon any new deployment, so you can still have more builds. */
    const rebuild = doc['_rebuild_pending'];
    if(rebuild){
      const minutes = (now - rebuild) / 60000;
      if(minutes < 60){
        res.status(429).send(`A rebuild of ${package} ${version} was already triggered ${Math.round(minutes)} minutes ago.`);
        return;
      }
    }
    var buildurl = doc._buildurl;
    if(!buildurl) {
      throw `Failed to find _buildurl in ${package} ${version}`;
    }
    const pattern = new RegExp('https://github.com/(r-universe/.*/actions/runs/[0-9]+)');
    const match = buildurl.match(pattern);
    if(!match || !match[1]) {
      throw 'Did not recognize github action url'
    }
    const run_path = match[1];
    return tools.get_submodule_hash(user, package).then(function(sha){
      if(sha !== doc._commit.id){
        throw `Build version of ${package} not match ${user} monorepo. Package may have been updated or removed in the mean time.` +
          `\nUpstream: ${sha}\nThis build: ${doc._commit.id}`
      }
      return tools.trigger_rebuild(run_path).then(function(){
        return packages.updateOne(
          { _id: doc['_id'] },
          { "$set": {"_rebuild_pending": now }}
        ).then(function(){
          res.send({
            run: run_path,
            time: now
          });
        });
      });
    }); /* plain-text error to show in UI alert box */
  }).catch(err => res.status(400).send(err));
});

/* HTTP PATCH does not require authentication, so this API is public for now
 * When the front-end has some auth, we can switch to post */
router.patch("/:user/api/recheck/:target",function(req, res, next) {
  var user = req.params.user;
  var target = req.params.target;
  var query = {_user : user, _type : 'src', '_commit.id': target};
  var now = new Date();
  return packages.find(query).next().then(function(doc){
    if(doc['_recheck_date']){
      var minutes = (doc['_recheck_date'] - now) / 60000;
      return res.status(429).send(`A recheck of ${doc.Package} was already triggered ${Math.round(minutes)} minutes ago.`);
    }
    return tools.trigger_recheck(doc._user, doc.Package).then(function(){
      return packages.updateOne(
        { _id: doc['_id'] },
        { "$set": {"_recheck_date": now }}
      ).then(function(){
        res.send("Success");
      });
    });
  }).catch(error_cb(400, next));
});

/* This API is called by the CI to update the status */
router.post("/:user/api/recheck/:package",function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var query = {_user : user, _type : 'src', Package: package};
  return packages.find(query).next().then(function(doc){
    return packages.updateOne(
      { _id: doc['_id'] },
      { "$set": {"_recheck_url": req.body.url }}
    ).then(function(){
      res.send("Update OK");
    });
  }).catch(error_cb(400, next));
});

router.post('/:user/api/reindex', function(req, res, next) {
  var owners = {};
  fetch('https://r-universe-org.github.io/cran-to-git/universes.csv')
  .then((result) => result.text())
  .then(function(txt){
    return txt.trim().split('\n').forEach(function(doc){
      var arr = doc.split(',');
      var pkg = arr[0];
      var owner = arr[1];
      owners[pkg] = owner;
    })
  }).then(function(){
    return packages.find({_type:'src'}).forEach(function(doc){
      console.log(`Updating: ${doc.Package}`)
      var realowner = owners[doc.Package];
      var indexed = (!realowner && doc['_registered']) || (realowner == doc['_user']);
      return packages.updateOne(
        { _id: doc['_id'] },
        { "$set": {"_realowner": realowner, "_indexed": indexed}}
      );
    });
  }).then(function(x){
    res.send(owners);
  });
});

function extract_json_metadata(input, package){
  return tools.extract_multi_files(input, [`${package}/extra/contents.json`]).then(function(files){
    if(!files[0]){
      throw `Source package did not contain ${package}/extra/contents.json`;
    }
    var metadata = JSON.parse(files[0]);
    if(!metadata.assets){
      throw "contents.json seems invalid";
    }
    return metadata;
  });
}

module.exports = router;
