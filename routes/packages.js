/* Packages */
import express from 'express';
import createError from 'http-errors';
import multer from 'multer';
import rdesc from 'rdesc-parser';
import fs from 'node:fs';
import zlib from 'node:zlib';
import tar from 'tar-stream';
import crypto from 'node:crypto';
import rconstants from 'r-constants';
import {match_macos_arch, trigger_rebuild, trigger_recheck, get_submodule_hash, extract_multi_files} from '../src/tools.js';
import {packages, bucket, chunks, db} from '../src/db.js';
import {Buffer} from "node:buffer";

/* Local variables */
const multerstore = multer({ dest: '/tmp/' });
const router = express.Router();

/* Error generator */
function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

//Remove file from bucket if there are no more references to it
function delete_file(key){
  return packages.findOne({_fileid : key}).then(function(doc){
    if(doc){
      console.log("Found other references, not deleting file: " + key);
    } else {
      return bucket.delete(key).then(function(){
        console.log("Deleted file " + key);
      });
    }
  });
}

function delete_doc(doc, keep_file_id){
  if(!doc._fileid) throw "Calling delete_doc without doc._fileid";
  return packages.deleteOne({_id: doc['_id']}).then(function(){
    if(doc._fileid !== keep_file_id){
      return delete_file(doc._fileid).then(()=>doc);
    }
  });
}

function delete_by_query(query){
  return packages.find(query).project({_id:1, _fileid:1, Package:1, Version:1}).toArray().then(function(docs){
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
  var query = {_user : user, Package : req.params.package};
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
    var hash = crypto.createHash('sha256');
    var pipe = stream.on('data', data => hash.update(data)).pipe(upload);
    pipe.on('error', function(err){
      console.log("Error in openUploadStreamWithId()" + err);
      /* Clear possible orphaned chunks, then reject */
      chunks.deleteMany({files_id: key}).finally(function(e){
        reject("Error in openUploadStreamWithId(): " + err);
      });
    });
    pipe.on('finish', function(){
      /* Right now we still assume the uploader uses md5 keys */
      db.command({filemd5: key, root: "files"}).then(function(check){
        var shasum = hash.digest('hex');
        if(key == shasum || key == check.md5) {
          resolve({_id: key, length: upload.length, md5: check.md5, sha256: shasum});
        } else {
          bucket.delete(key).finally(function(){
            console.log(`Checksum for ${filename} did not match`);
            reject(`Checksum for ${filename} did not match`);
          });
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

function get_filename(pkgname, version, type, distro){
  const ext = {
    src : '.tar.gz',
    mac : '.tgz',
    win : '.zip',
    wasm: '.tgz',
    linux: `-${distro || "linux"}.tar.gz`
  }
  return pkgname + "_" + version + ext[type];
}

function validate_description(data, pkgname, version, type){
  if(['src', 'win', 'mac', 'linux', 'wasm'].indexOf(type) < 0){
    throw "Parameter 'type' must be one of src, win, mac, linux, wasm";
  } 
  if(data.Package != pkgname || data.Version != version) {
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
  rconstants.dependency_types.forEach(function(key){
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

//weigh scores relative to github-stars
//each metric is scored on a log10 scale, e.g. 10 star is 1 point, 100 stars is 2 points, etc.
function calculate_score(description){
  var score = 1;
  function add_score(value){
    score += Math.log10(Math.max(1, value || 0));
  }
  add_score(description._stars);
  add_score(description._usedby * 3); //one revdep ~ 3 stars
  add_score(description._searchresults / 10); //10 scripts ~ one star
  if(Array.isArray(description._vignettes))
    add_score(description._vignettes.length * 10); //one vignette ~ 10 stars
  if(Array.isArray(description._datasets * 5)) //one dataset ~ 5 stars
    add_score(description._datasets.length);
  if(Array.isArray(description._updates))
    add_score(description._updates.length);
  if(typeof description._contributions === 'object')
    add_score(Object.keys(description._contributions).length - 1)
  if(description._cranurl || description._bioc)
    add_score(10); //on cran/bioc ~ 10 stars
  if(description._readme)
    add_score(5); //has readme ~ 5 stars
  if(description._downloads && description._downloads.count > 0)
    add_score(description._downloads.count / 1000); //1000 downloads ~ one star
  if(description._mentions)
    add_score(Math.min(description._mentions, 10)); //some false positives, add max 1 point
  return score;
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

router.put('/:user/packages/:package/:version/:type/:key', function(req, res, next){
  var user = req.params.user;
  var pkgname = req.params.package;
  var version = req.params.version;
  var type = req.params.type;
  var key = req.params.key;
  var query = {_user : user, _type : type, Package : pkgname};
  var builder = parse_builder_fields(req.headers) || {};
  var filename = get_filename(pkgname, version, type, builder.distro);
  crandb_store_file(req, key, filename).then(function(filedata){
    if(type == 'src'){
      var p1 = packages.countDocuments({_type: 'src', _indexed: true, '_rundeps': pkgname});
      var p2 = extract_json_metadata(bucket.openDownloadStream(key), pkgname);
      var p3 = packages.find({_type: 'src', Package: pkgname, _indexed: true}).project({_user:1}).next();
      return Promise.all([filedata, p1, p2, p3]);
    } else {
      return [filedata];
    }
  }).then(function([filedata, usedby, headerdata, canonical]){
    //console.log(`Successfully stored file ${filename} with ${runrevdeps} runreveps`);
    return read_description(bucket.openDownloadStream(key)).then(function(description){
      description['MD5sum'] = filedata.md5;
      description['_user'] = user;
      description['_type'] = type;
      description['_file'] = filename;
      description['_fileid'] = filedata['_id'];
      description['_filesize'] = filedata.length;
      description['_sha256'] = filedata.sha256;
      description['_created'] = get_created(description);
      description['_published'] = new Date();
      add_meta_fields(description, builder);
      merge_dependencies(description);
      validate_description(description, pkgname, version, type);
      description['_owner'] = get_repo_owner(description._upstream);
      description['_selfowned'] = is_self_owned(description);
      if(type == "src"){
        description['_usedby'] = usedby;
        add_meta_fields(description, headerdata); //contents.json
        description['_score'] = calculate_score(description);
        description['_indexed'] = is_indexed(description);
        description['_nocasepkg'] = pkgname.toLowerCase();
        set_universes(description);
        if(description['_indexed'] === false && canonical){
          description['_indexurl'] = `https://${canonical['_user']}.r-universe.dev/${pkgname}`;
        }
      } else {
        query['Built.R'] = {$regex: '^' + parse_major_version(description.Built)};
      }
      if(type == 'mac' && description.Built.Platform){
        query['Built.Platform'] = match_macos_arch(description.Built.Platform);
      }
      return packages.find(query).project({_id:1, _fileid:1, Version: 1}).toArray().then(function(docs){
        if(docs.length > 1)
          console.log(`WARNING: deleting duplicates for ${JSON.stringify(query)}`);
        if(docs.length > 3)
          throw `Found too many duplicates, something seems off`;
        var previous = docs[0];
        if(previous && (previous.Version !== description.Version))
          description._previous = previous.Version;
        return Promise.all(docs.map(x => delete_doc(x, key)));
      }).then(function(x){
        return packages.insertOne(description);
      }).then(function(){
        if(type === 'src'){
          return packages.deleteMany({_type : 'failure', _user : user, Package : pkgname});
        }
      }).then(() => res.send(description));  
    }).catch(function(e){
      return delete_file(key).then(()=>{throw e});
    });
  }).catch(error_cb(400, next));
});

router.post('/:user/packages/:package/:version/update', multerstore.none(), function(req, res, next) {
  var user = req.params.user;
  var version = req.params.version;
  var query = {_type : 'src', _user : user, Package : req.params.package, Version: version};
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
  var pkgname = req.params.package;
  var version = req.params.version;
  var builder = parse_builder_fields(req.body);
  var maintainer = `${builder.maintainer.name} <${builder.maintainer.email}>`;
  var query = {_type : 'failure', _user : user, Package : pkgname};
  var description = {...query, Version: version, Maintainer: maintainer, _published: new Date()};
  add_meta_fields(description, builder);
  description['_created'] = new Date();
  description['_owner'] = get_repo_owner(description._upstream);
  description['_selfowned'] = description._owner === user;
  description['_universes'] = [user]; //show failures in dashboard
  description['_nocasepkg'] = pkgname.toLowerCase();
  packages.findOneAndReplace(query, description, {upsert: true})
    .then(() => res.send(description))
    .catch(error_cb(400, next))
});

router.post('/:user/packages/:package/:version/:type', multerstore.fields([{ name: 'file', maxCount: 1 }]), function(req, res, next) {
  if(!req.files.file || !req.files.file[0]){
    return next(createError(400, "Missing parameter 'file' in upload"));
  }
  var user = req.params.user;
  var pkgname = req.params.package;
  var version = req.params.version;
  var type = req.params.type;
  var query = {_user : user, _type : type, Package : pkgname};
  var filepath = req.files.file[0].path;
  var filename = req.files.file[0].originalname;
  var key = req.body.key;
  var builder = parse_builder_fields(req.body);
  var stream = fs.createReadStream(filepath);
  crandb_store_file(stream, key, filename).then(function(filedata){
    if(type == 'src'){
      var p1 = packages.countDocuments({_type: 'src', _indexed: true, '_rundeps': pkgname});
      var p2 = extract_json_metadata(bucket.openDownloadStream(key), pkgname);
      return Promise.all([filedata, p1, p2]);
    } else {
      return [filedata];
    }
  }).then(function([filedata, usedby, headerdata]){
    return read_description(bucket.openDownloadStream(key)).then(function(description){
      description['MD5sum'] = filedata.md5;
      description['_user'] = user;
      description['_type'] = type;
      description['_file'] = filename;
      description['_fileid'] = filedata['_id'];
      description['_filesize'] = filedata.length;
      description['_sha256'] = filedata.sha256;
      description['_created'] = get_created(description);
      description['_published'] = new Date();
      add_meta_fields(description, builder);
      merge_dependencies(description);
      validate_description(description, pkgname, version, type);
      description['_owner'] = get_repo_owner(description._upstream);
      description['_selfowned'] = is_self_owned(description);
      if(type == "src"){
        description['_usedby'] = usedby;
        add_meta_fields(description, headerdata); //contents.json
        description['_score'] = calculate_score(description);
        description['_indexed'] = is_indexed(description);
        description['_nocasepkg'] = pkgname.toLowerCase();
        set_universes(description);
      } else {
        query['Built.R'] = {$regex: '^' + parse_major_version(description.Built)};
      }
      if(type == 'mac' && description.Built.Platform){
        query['Built.Platform'] = match_macos_arch(description.Built.Platform);
      }
      return packages.find(query).project({_id:1, _fileid:1, Version: 1}).toArray().then(function(docs){
        if(docs.length > 1)
          console.log(`WARNING: deleting duplicates for ${JSON.stringify(query)}`);
        if(docs.length > 3)
          throw `Found too many duplicates, something seems off`;
        var previous = docs[0];
        if(previous && (previous.Version !== description.Version))
          description._previous = previous.Version;
        return Promise.all(docs.map(x => delete_doc(x, key)));
      }).then(function(x){
        return packages.insertOne(description);
      }).then(function(){
        if(type === 'src'){
          return packages.deleteMany({_type : 'failure', _user : user, Package : pkgname});
        }
      }).then(() => res.send(description));
    }).catch(function(e){
      return delete_file(key).then(()=>{throw e});
    });
  }).catch(error_cb(400, next)).then(function(){
    fs.unlink(filepath, () => console.log("Deleted tempfile: " + filepath));
  });
});

/* HTTP PATCH does not require authentication, so this API is public */
router.patch('/:user/packages/:package/:version/:type', function(req, res, next) {
  var user = req.params.user;
  var pkgname = req.params.package;
  var version = req.params.version;
  var type = req.params.type || 'src'
  var query = {_user : user, _type : type, Package : pkgname, Version: version};
  packages.find(query).next().then(function(doc){
    if(!doc) {
      throw `Failed to find package ${pkgname} ${version} in ${user}`;
    }
    const now = new Date();
    /* Try to prevent hammering of the GH API. However note that the _rebuild_pending field
       automatically disappears upon any new deployment, so you can still have more builds. */
    const rebuild = doc['_rebuild_pending'];
    if(rebuild){
      const minutes = (now - rebuild) / 60000;
      if(minutes < 60){
        res.status(429).send(`A rebuild of ${pkgname} ${version} was already triggered ${Math.round(minutes)} minutes ago.`);
        return;
      }
    }
    var buildurl = doc._buildurl;
    if(!buildurl) {
      throw `Failed to find _buildurl in ${pkgname} ${version}`;
    }
    const pattern = new RegExp('https://github.com/(r-universe/.*/actions/runs/[0-9]+)');
    const match = buildurl.match(pattern);
    if(!match || !match[1]) {
      throw 'Did not recognize github action url'
    }
    const run_path = match[1];
    return get_submodule_hash(user, pkgname).then(function(sha){
      if(sha !== doc._commit.id){
        throw `Build version of ${pkgname} not match ${user} monorepo. Package may have been updated or removed in the mean time.` +
          `\nUpstream: ${sha}\nThis build: ${doc._commit.id}`
      }
      return trigger_rebuild(run_path).then(function(){
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
    return trigger_recheck(doc._user, doc.Package).then(function(){
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
  var query = {_user : user, _type : 'src', Package: req.params.package};
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
      var [pkg, owner] = doc.split(',');
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

function extract_json_metadata(input, pkgname){
  return extract_multi_files(input, [`${pkgname}/extra/contents.json`]).then(function([contents]){
    if(!contents){
      throw `Source package did not contain ${pkgname}/extra/contents.json`;
    }
    var metadata = JSON.parse(contents);
    if(!metadata.assets){
      throw "contents.json seems invalid";
    }
    if(!metadata.userbio || !metadata.userbio.type){
      throw "userbio is missing from contents.json";
    }
    return metadata;
  });
}

export default router;
