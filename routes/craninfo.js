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

router.get('/:user/craninfo', function(req, res, next) {
  tools.get_cran_info(req.query.package, req.query.url).then(function(info){
    res.send(info);
  }).catch(error_cb(400, next));
});

module.exports = router;
