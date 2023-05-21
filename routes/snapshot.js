const express = require('express');
const createError = require('http-errors');
const router = express.Router();
const archiver = require('archiver');

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
    return `bin/linux/${distro}/src/contrib/${doc.Package}_${doc.Version}.tar.gz`;
  }
  throw `Unsupported type: ${type}`;
}

function packages_snapshot(docs, archive){
  var promises = docs.map(function(doc){
    var hash = doc.MD5sum;
    var date = doc._created;
    var filename = make_filename(doc);
    return bucket.find({_id: hash}, {limit:1}).next().then(function(x){
      if (!x)
        throw `Failed to locate file in gridFS: ${hash}`;
      var input = bucket.openDownloadStream(x['_id']);
      return archive.append(input, { name: filename, date: date });
    });
  });
  return Promise.allSettled(promises).then(function(){
    //TODO: add PACKAGES(gz) files
    archive.finalize();
    return docs;
  });
}

router.get('/:user/snapshot/:format', function(req, res, next) {
  var user = req.params.user;
  var format = req.params.format;
  var query = {_user: user, _type: req.query.type || {'$ne' : 'failure'}};
  var cursor = packages.find(query).sort({"_id" : -1});
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
