import express from 'express';
import createError from 'http-errors';
import zlib from 'node:zlib';
import archiver from 'archiver';
import path from 'node:path';
import {pkgfields, doc_to_dcf, get_extracted_file} from '../src/tools.js';
import {packages, bucket} from '../src/db.js';

const router = express.Router();

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function new_zipfile(format){
  /* contents are already compressed */
  const archive = archiver(format, {
    store: true, gzip: true, gzipOptions: {level: 1},
  });
  archive.append_stream = function(source, data){
    return new Promise((resolve, reject) => {
      source.on('end', resolve);
      source.on('error', reject);
      //archive.on('entry', resolve);
      archive.append(source, data);
    });
  }
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

function make_storepaths(doc){
  var type = doc._type;
  if(type == 'src'){
    return [`src/contrib/${doc.Package}_${doc.Version}.tar.gz`];
  }
  var built = doc.Built && doc.Built.R && doc.Built.R.substring(0,3);
  if(type == 'win'){
    return [`bin/windows/contrib/${built}/${doc.Package}_${doc.Version}.zip`];
  }
  if(type == 'mac'){
    var intel = `bin/macosx/big-sur-x86_64/contrib/${built}/${doc.Package}_${doc.Version}.tgz`;
    var arm = `bin/macosx/big-sur-arm64/contrib/${built}/${doc.Package}_${doc.Version}.tgz`;
    if(doc.Built.Platform){
      return [doc.Built.Platform.match("x86_64") ? intel : arm];
    } else {
      return [intel, arm];
    }
  }
  if(type == 'linux'){
    var distro = doc.Distro || 'linux';
    return [`bin/linux/${distro}/${built}/src/contrib/${doc.Package}_${doc.Version}.tar.gz`];
  }
  if(type == 'wasm'){
    return [`bin/emscripten/contrib/${built}/${doc.Package}_${doc.Version}.tgz`];
  }
  throw `Unsupported type: ${type}`;
}

async function packages_snapshot(files, archive, types){
  var indexes = {};
  for (var x of files){
    if(types.includes(x._type)){
      for (var filename of make_storepaths(x)){
        var dirname = path.dirname(filename);
        if(!indexes[dirname])
          indexes[dirname] = [];
        indexes[dirname].push(x);
        var input = bucket.openDownloadStream(x._fileid);
        await archive.append_stream(input, { name: filename, date: x._created });
      }
    }
  };

  /* Generate PACKAGES indexes */
  for (const [path, files] of Object.entries(indexes)) {
    var packages = files.map(doc_to_dcf).join('');
    archive.append(packages, { name: `${path}/PACKAGES` });
    archive.append(zlib.gzipSync(packages), { name: `${path}/PACKAGES.gz`});
  }

  /* Extract html manual pages. This is a bit slower so doing this last */
  if(types.includes('docs')) {
    for (var x of files.filter(x => x._type == 'src')){
      var pkgname = x.Package;
      var buf = await get_extracted_file({_id: x._id}, `${pkgname}/extra/${pkgname}.html`);
      archive.append(buf, { name: `docs/${pkgname}.html`, date: x._created });
    };
  }
}

router.get('/:user/api/snapshot/:format?', function(req, res, next) {
  var user = req.params.user;
  var query = {_user: user, _type: {'$ne' : 'failure'}};
  var types = req.query.types ? req.query.types.split(',') : ['src', 'win', 'mac', 'linux', 'docs']; //skip wasm
  if(req.query.packages)
    query.Package = {'$in' : req.query.packages.split(",")};
  var cursor = packages.find(query).project(pkgfields).sort({"_type" : 1});
  cursor.toArray().then(function(files){
    if(!files.length)
      throw "Query returned no packages";
    if(req.query.binaries){
      var allowed = req.query.binaries.split(",");
      files = files.filter(function(doc){
        var binver = doc.Built && doc.Built.R || "";
        return doc._type == 'src' || allowed.find(ver => binver.startsWith(ver));
      });
    }
    var format = req.params.format || "zip";
    var archive = new_zipfile(format);
    if(format == 'zip'){
      res.type('application/zip').attachment(`${user}-snapshot.zip`)
    } else if(format == 'tar') {
      res.type('application/gzip').attachment(`${user}-snapshot.tar.gz`)
    } else {
      throw "Unsupported snapshot format: " + format;
    }
    archive.pipe(res);
    packages_snapshot(files, archive, types).then(function(){
      archive.finalize();
    }).catch(function(err){
      archive.abort();
      throw err;
    })
  }).catch(error_cb(400, next));
});

export default router;
