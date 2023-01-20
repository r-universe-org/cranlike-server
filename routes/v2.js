const express = require('express');
const createError = require('http-errors');
const router = express.Router();
const tools = require("../src/tools.js");
const send_extracted_file = tools.send_extracted_file;


/* Error generator */
function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

//TODO: unify with /landing ?
router.get("/v2/:user", function(req, res, next) {
  var user = req.params.user;
  tools.test_if_universe_exists(user).then(function(x){
    if(!x) return res.type('text/plain').status(404).send('No universe for user: ' + user);
    if(req.path.substr(-1) != '/'){
      res.redirect(`/v2/${user}/`);
    } else {
      res.type('text/plain').send(`Universe homepage ${user} here...`);
    }
  }).catch(error_cb(404, next));
});

router.get("/v2/:user/:package", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  find_package(user, package).then(function(){
    if(req.path.substr(-1) != '/'){
      res.redirect(`/v2/${user}/${package}/`);
    } else {
      res.type('text/plain').send(`Package homepage ${user}/${package} here...`);
    }
  }).catch(error_cb(404, next));
});

router.get("/v2/:user/:package/json", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  find_package(user, package).then(function(x){
    res.send(x);
  }).catch(error_cb(400, next));
});


/* Match CRAN / R dynamic help */
router.get("/v2/:user/:package/DESCRIPTION", function(req, res, next) {
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var filename = `${package}/DESCRIPTION`;
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

/* Match CRAN / R dynamic help */
router.get('/v2/:user/:package/NEWS:ext?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var ext = req.params.ext || '.html';
  var filename = `${package}/extra/NEWS${ext}`
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

/* Match CRAN */
router.get('/v2/:user/:package/citation:ext?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var ext = req.params.ext || '.html';
  var filename = `${package}/extra/citation${ext}`
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

// TODO: move all these files under /inst/doc at build time?
function doc_path(file, package){
  switch(file.toLowerCase()) {
    case "readme":
    case "readme.html":
      return `${package}/readme.html`;
    case "readme.md":
      return `${package}/readme.md`;
    case `${package}-manual.pdf`:
      return `${package}/manual.pdf`
    case `${package}-manual.html`:
      return `${package}/extra/${package}.html`;
    default:
      return `${package}/inst/doc/${file}`;
  }
}

router.get('/v2/:user/:package/doc/:file?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var file = req.params.file;
  var filename = file ? doc_path(file, package) : new RegExp(`^${package}/inst/doc/(.+)$`);
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

function find_package(user, package){
  const query = {'_user': user, 'Package': package, '_type': 'src'};
  return packages.findOne(query).then(function(x){
    if(!x) {
      throw `Package ${user}/${package} not found`;
    }
    return x;
  });
}

module.exports = router;
