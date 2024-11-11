import express from 'express';
import createError from 'http-errors';
import {bucket} from '../src/db.js';

const router = express.Router();

function stream_file(x){
  return bucket.openDownloadStream(x['_id']);
}

function send_from_bucket(hash, operation, res){
  return bucket.find({_id: hash}, {limit:1}).next().then(function(pkg){
    if(!pkg){
      return res.status(410).type("text/plain").send(`File ${hash} not available (anymore)`);
    }
    let name = pkg.filename;
    if(operation == 'send'){
      let type = name.endsWith('.zip') ? 'application/zip' : 'application/x-gzip';
      return stream_file(pkg).pipe(
        res.type(type).attachment(name).set({
          'Content-Length': pkg.length,
          'Cache-Control': 'public, max-age=31557600, immutable',
          'Last-Modified' : pkg.uploadDate.toUTCString()
        })
      );
    }
    throw createError(500, `Unsuppored operation ${operation}`);
  });
}

/* Reduce noise from crawlers in log files */
router.get("/cdn/robots.txt", function(req, res, next) {
  res.type('text/plain').send(`User-agent: *\nDisallow: /\n`);
});

router.get("/cdn/:hash{/:file}", function(req, res, next) {
  let hash = req.params.hash || "";
  let file = req.params.file || "send";
  if(hash.length != 32 && hash.length != 64) //can be md5 or sha256
    return next(createError(400, "Invalid hash length"));
  return send_from_bucket(hash, file, res);
});

/* index all the files, we have nothing to hide */
router.get("/cdn", function(req, res, next) {
  var cursor = bucket.find({}, {sort: {uploadDate: -1}, project: {_id: 1, filename: 1}});
  return cursor.stream({transform: x => `${x._id} ${x.uploadDate.toISOString()} ${x.filename}\n`}).pipe(res.type('text/plain'));
});

export default router;
