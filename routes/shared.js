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
  find_cran_package(package).then(function(x){
    if(!x){
      res.status(404).type('text/plain').send(`Package ${package} not found on CRAN.`);
    } else {
      var manual = '/doc/manual.html';
      var realowner = x._realowner || 'cran';
      if(req.headers.host == 'api.cran.dev'){
        var out = {
          package: x.Package,
          maintainer: x.Maintainer,
          home : `https://cran.r-universe.dev/${x.Package}`,
          release : {
            version: x.Version,
            date: x._created,
            source: x.RemoteUrl,
            repository: 'https://cloud.r-project.org',
            docs: `https://cran.r-universe.dev/${x.Package}${manual}`,
            api:  `https://cran.r-universe.dev/api/packages/${x.Package}`
          }
        };
        packages.findOne({Package : x.Package, _user : realowner}).then(function(y){
          if(y){
            out.home = `https://${y._user}.r-universe.dev/${y.Package}`;
            if(y._owner != 'cran') {
              out.devel = {
                version: y.Version,
                date: y._created,
                source: y.RemoteUrl,
                repository: `https://${y._user}.r-universe.dev`,
                docs: `https://${y._user}.r-universe.dev/${x.Package}${manual}`,
                api:  `https://${y._user}.r-universe.dev/api/packages/${y.Package}`
              };
            }
          }
          res.send(out);
        });
      } else {
        var path = req.headers.host == 'docs.cran.dev' ? manual : req.params['0'] || "";
        res.set('Cache-Control', 'max-age=3600, public').redirect(`https://${realowner}.r-universe.dev/${x.Package}${path}`);
      }
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

router.get('/shared/mongostatus', function(req, res, next) {
  packages.indexes().then(function(indexes){
    var out = {indexes: indexes}
    res.send(out);
  }).catch(error_cb(400, next))
});

function find_cran_package(package){
  var regex = {$regex: `^${package}$`, $options: 'i'};
  return packages.findOne({Package : regex, _type : 'src', _user : 'cran'}).then(function(x){
    if(x) return x;
    /* fallback for packages misssing from the CRAN mirror for whatever reason */
    return packages.findOne({Package : regex, _type : 'src', _indexed : true}).then(function(y){
      if(y && y._realowner == y['_user']){
        return y;
      }
    });
  });
}

module.exports = router;
