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

/* Proper file extension is required for CloudFlare caching */
router.get("/cdn/:hash/:file", function(req, res, next) {
  let hash = req.params.hash;
  let file = req.params.file || "";
  let cursor = bucket.find({_id: hash}, {limit:1});
  cursor.hasNext().then(function(exists){
    if(!exists)
      throw "Failed to locate file in gridFS: " + hash;
    return cursor.next().then(function(x){
      if(file !== x.filename){
        throw `Incorrect filename ${file} (should be be ${x.filename})`;
      }
      let type = x.filename.endsWith('.zip') ? 'application/zip' : 'application/x-gzip';
      return bucket.openDownloadStream(x['_id']).pipe(
        res.type(type).set({
          'Content-Length': x.length,
          'Cache-Control': 'public, max-age=31557600',
          'Last-Modified' : x.uploadDate.toUTCString()
        })
      );
    })
  }).catch(error_cb(400, next));
});

module.exports = router;
