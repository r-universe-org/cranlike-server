import express from 'express';
import createError from 'http-errors';
import {bucket} from '../src/db.js';

const router = express.Router();

/* Error generator */
function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function send_from_bucket(hash, res){
  return bucket.find({_id: hash}, {limit:1}).next().then(function(x){
    if(!x)
      throw `Failed to locate file in gridFS: ${hash}`;
    let type = x.filename.endsWith('.zip') ? 'application/zip' : 'application/x-gzip';
    return bucket.openDownloadStream(x['_id']).pipe(
      res.type(type).attachment(x.filename).set({
        'Content-Length': x.length,
        'Cache-Control': 'public, max-age=31557600',
        'Last-Modified' : x.uploadDate.toUTCString()
      })
    );
  });
}

/* Proper file extension is required for CloudFlare caching */
/* Although I have now added a cloudflare rule to 'cache-everything' */
router.get("/cdn/:hash/:file?", function(req, res, next) {
  let hash = req.params.hash || "";
  let file = req.params.file || "";
  if(hash.length != 32 && hash.length != 64 ) //assume md5 for now
    return next(createError(400, "Invalid hash length"));
  send_from_bucket(hash, res).catch(error_cb(400, next));
});

router.get("/cdn/", function(req, res, next) {
  next(createError(400, "Invalid request"));
});

export default router;
