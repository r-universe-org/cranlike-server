const express = require('express');
const createError = require('http-errors');
const zlib = require('zlib');
const router = express.Router();
const archiver = require('archiver');
const path = require('node:path');
const tools = require("../src/tools.js");
const pkgfields = tools.pkgfields;
const doc_to_dcf = tools.doc_to_dcf;

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function new_zipfile(format){
  const archive = archiver(format, {
    gzip: true, zlib: { level: 9 }
  });
  return archive.on('warning', function(err) {
    if (err.code === 'ENOENT') {
      console.log(err)
    } else {
      throw err;
    }
  }).on('error', function(err) {
    throw err;
  })
}

function make_filename(doc){
  var type = doc._type;
  if(type == 'src'){
    return `src/contrib/${doc.Package}_${doc.Version}.tar.gz`;
  }
  var built = doc.Built && doc.Built.R && doc.Built.R.substring(0,3);
  if(type == 'win'){
    return `bin/windows/contrib/${built}/${doc.Package}_${doc.Version}.zip`;
  }
  if(type == 'mac'){
    //TODO: fix arm64 m1 distro here, once supported
    var distro = built == '4.2' ? 'macosx' : 'macosx/big-sur-x86_64';
    return `bin/${distro}/contrib/${built}/${doc.Package}_${doc.Version}.tgz`;
  }
  if(type == 'linux'){
    var distro = doc._builder && doc._builder.distro || 'linux';
    return `bin/linux/${distro}/${built}/src/contrib/${doc.Package}_${doc.Version}.tar.gz`;
  }
  throw `Unsupported type: ${type}`;
}

function packages_snapshot(docs, archive){
  var indexes = {};
  var promises = docs.map(function(doc){
    var hash = doc.MD5sum;
    var date = doc._created;
    var filename = make_filename(doc);
    var dirname = path.dirname(filename);
    if(!indexes[dirname])
      indexes[dirname] = [];
    indexes[dirname].push(doc);
    return bucket.find({_id: hash}, {limit:1}).next().then(function(x){
      if (!x)
        throw `Failed to locate file in gridFS: ${hash}`;
      var input = bucket.openDownloadStream(x['_id']);
      return archive.append(input, { name: filename, date: date });
    });
  });
  return Promise.allSettled(promises).then(async function(){
    for (const [path, docs] of Object.entries(indexes)) {
      var packages = docs.map(doc_to_dcf).join('');
      await archive.append(packages, { name: `${path}/PACKAGES` });
      await archive.append(zlib.gzipSync(packages), { name: `${path}/PACKAGES.gz` });
    }
    archive.finalize();
    return docs;
  });
}

router.get('/:user/snapshot/:format', function(req, res, next) {
  var user = req.params.user;
  var format = req.params.format;
  var query = {_user: user, _type: req.query.type || {'$ne' : 'failure'}};
  var cursor = packages.find(query).project(pkgfields).sort({"Package" : 1});
  cursor.toArray().then(function(docs){
    if(!docs.length)
      throw "Query returned no packages";
    var archive = new_zipfile(format);
    if(format == 'zip'){
      res.type('application/zip').attachment(`${user}-snapshot.zip`)
    } else if(format == 'tar') {
      res.type('application/gzip').attachment(`${user}-snapshot.tar.gz`)
    } else {
      throw "Unsupported snapshot format: " + format;
    }
    archive.pipe(res);
    packages_snapshot(docs, archive);
  }).catch(error_cb(400, next));
});

module.exports = router;
