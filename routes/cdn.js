const express = require('express');
const createError = require('http-errors');
const router = express.Router();

/* Error generator */
function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function send_from_bucket(hash, file, res){
  return bucket.find({_id: hash}, {limit:1}).next().then(function(x){
    if(!x)
      throw `Failed to locate file in gridFS: ${hash}`;
    if(file !== x.filename)
      throw `Incorrect filename ${file} (should be be ${x.filename})`;
    let type = x.filename.endsWith('.zip') ? 'application/zip' : 'application/x-gzip';
    return bucket.openDownloadStream(x['_id']).pipe(
      res.type(type).set({
        'Content-Length': x.length,
        'Cache-Control': 'public, max-age=31557600',
        'Last-Modified' : x.uploadDate.toUTCString()
      })
    );
  });
}

/* Proper file extension is required for CloudFlare caching */
router.get("/cdn/:hash/:file", function(req, res, next) {
  let hash = req.params.hash || "";
  let file = req.params.file || "";
  if(hash.length != 32) //assume md5 for now
    return next(createError(400, "Invalid hash length"));
  send_from_bucket(hash, file, res).catch(error_cb(400, next));
});

router.get("/cdn/", function(req, res, next) {
  next(createError(400, "Invalid request"));
});

module.exports = router;
