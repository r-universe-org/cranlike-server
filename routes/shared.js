import express from 'express';
import createError from 'http-errors';
import webr from '@r-universe/webr';
import {get_cran_desc} from '../src/tools.js';
import {packages} from '../src/db.js';

const router = express.Router();
const session = new webr.WebR();
session.init();

function unsplat(x){
  if(!x || !x.length) return "";
  if(Array.isArray(x)){
    return x.map(val => `/${val}`).join("");
  }
  return x;
}

router.get('/shared/redirect/:package{/*path}', function(req, res, next) {
  var pkgname = req.params.package;
  find_cran_package(pkgname).then(function(x){
    if(!x){
      find_cran_package(pkgname, 'failure').then(function(y){
        if(y){
          res.status(404).type('text/plain').send(`CRAN package ${pkgname} failed to build on r-universe: ${y._buildurl}`);
        } else {
          res.status(404).type('text/plain').send(`Package ${pkgname} not found on CRAN.`);
        }
      });
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
        packages.findOne({Package : x.Package, _user : realowner, _type: 'src'}).then(function(y){
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
        var path = req.headers.host == 'docs.cran.dev' ? manual : unsplat(req.params.path);
        res.set('Cache-Control', 'max-age=3600, public').redirect(`https://${realowner}.r-universe.dev/${x.Package}${path}`);
      }
    }
  });
});

router.get('/shared/cranstatus/:package', function(req, res, next) {
  return get_cran_desc(req.params.package).then(function(info){
    return res.set('Cache-Control', 'max-age=3600, public').send(info);
  });
});

router.get('/shared/webrstatus', function(req, res, next) {
  const promise = new session.Shelter();
  return promise.then(function(shelter){
    return shelter.captureR(`print(sessionInfo()); cat("\n"); print(installed.packages()[,2:4])`).then(function(out){
      var txt = out.output.map(function(x){
        return x.data;
      })
      res.type("text/plain").send(txt.join('\n'));
    }).finally(function(){
      return shelter.purge();
    });
  });
});

router.get('/shared/mongostatus', function(req, res, next) {
  return packages.indexes().then(function(indexes){
    var out = {indexes: indexes}
    res.send(out);
  });
});

function find_cran_package(pkgname, type = 'src'){
  var pkgname = pkgname.toLowerCase();
  return packages.findOne({_nocasepkg : pkgname, _type : type, _user : 'cran'}).then(function(x){
    if(x) return x;
    /* fallback for packages misssing from the CRAN mirror for whatever reason */
    return packages.findOne({_nocasepkg : pkgname, _type : type, _indexed : true}).then(function(y){
      if(y && y._realowner == y['_user']){
        return y;
      }
    });
  });
}

export default router;
