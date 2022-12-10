var express = require('express');
var createError = require('http-errors');
var router = express.Router();
var tools = require("../src/tools.js");

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

router.get('/shared/cranstatus/:package', function(req, res, next) {
  tools.get_cran_desc(req.params.package).then(function(info){
    res.set('Cache-Control', 'max-age=3600, public').send(info);
  }).catch(error_cb(400, next));
});

module.exports = router;
