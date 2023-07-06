var express = require('express');
var createError = require('http-errors');
var router = express.Router();
var tools = require("../src/tools.js");
var webr = require("@r-universe/webr");
var session = new webr.WebR();
session.init();

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

router.get('/shared/redirect/:package*', function(req, res, next) {
  var package = req.params.package;
  var query = {
    Package : {$regex: `^${package}$`, $options: 'i'},
    '_type' : 'src',
    '_user' : 'cran'
  }
  packages.findOne(query).then(function(x){
    if(!x){
      res.status(404).type('text/plain').send(`Package ${package} not found on CRAN.`);
    } else {
      var realowner = x['_contents'] && x['_contents'].realowner || 'cran';
      res.redirect(`https://${realowner}.r-universe.dev/${x.Package}/${req.params['0'] || ""}`);
    }
  });
});

router.get('/shared/cranstatus/:package', function(req, res, next) {
  tools.get_cran_desc(req.params.package).then(function(info){
    res.set('Cache-Control', 'max-age=3600, public').send(info);
  }).catch(error_cb(400, next));
});

router.get('/shared/webrstatus', function(req, res, next) {
  const promise = new session.Shelter();
  promise.then(function(shelter){
    return shelter.captureR(`print(sessionInfo()); cat("\n"); print(installed.packages()[,2:4])`).then(function(out){
      var txt = out.output.map(function(x){
        return x.data;
      })
      res.type("text/plain").send(txt.join('\n'));
    }).finally(function(){
      return shelter.purge();
    });
  }).catch(error_cb(400, next))
});

module.exports = router;
