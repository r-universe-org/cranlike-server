const path = require('path');
const express = require('express');
const createError = require('http-errors');
const router = express.Router();
const tools = require("../src/tools.js");
const send_extracted_file = tools.send_extracted_file;
const tablist = ['builds', 'packages', 'contributors', 'articles', 'badges', 'feed.xml'];

/* Error generator */
function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function proxy_url(url, res){
  return fetch(url).then(function(response){
    var type = response.headers.get("Content-Type");
    return response.text().then(function(txt){
      return res.type(type).status(response.status).send(txt);
    });
  })
}

function send_dashboard_html(res){
  //res.sendFile(path.join(__dirname, '../homepage/homepage.html'));
  return proxy_url('https://jeroen.github.io/dashboard-v2/homepage.html', res);
}

//TODO: unify with /landing ?
router.get("/v2/:user", function(req, res, next) {
  var user = req.params.user;
  tools.test_if_universe_exists(user).then(function(x){
    if(!x) return res.type('text/plain').status(404).send('No universe for user: ' + user);
    if(req.path.substr(-1) != '/'){
      res.redirect(`/v2/${user}/`);
    } else {
      send_dashboard_html(res);
    }
  }).catch(error_cb(404, next));
});

//TODO: is there a better way
router.get("/v2/:user/articles*", function(req, res, next) {
  var user = req.params.user;
  tools.test_if_universe_exists(user).then(function(x){
    res.sendFile(path.join(__dirname, '../homepage/homepage.html'));
  }).catch(error_cb(404, next));
});

//Middleware: test if package exists, possibly fix case mismatch, otherwise 404
router.get("/v2/:user/:package*", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  if(tablist.includes(package)) {
    send_dashboard_html(res);
  } else {
    find_package(user, package).then(function(x){
      if(x.Package != package){
        res.redirect(req.path.replace(`/v2/${user}/${package}`, `/v2/${user}/${x.Package}`));
      } else {
        next();
      }
    }).catch(error_cb(404, next));
  }
});

router.get("/v2/:user/:package", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  find_package(user, package).then(function(x){
    if(req.path.substr(-1) == '/'){
      res.redirect(`/v2/${user}/${package}`);
    } else {
      send_dashboard_html(res);
    }
  }).catch(error_cb(400, next));
});

router.get("/v2/:user/:package/json", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  find_package(user, package).then(function(x){
    res.send(x);
  }).catch(error_cb(400, next));
});

router.get("/v2/:user/:package/files", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var query = {_user : user, Package : package};
  packages.find(query).sort({"Built.R" : -1}).toArray().then(docs => res.send(docs)).catch(error_cb(400, next));
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
router.get('/v2/:user/:package/:file.pdf', function(req, res, next){
  var package = req.params.package;
  if(package != req.params.file){
    return res.status(404).send(`Did you mean ${package}.pdf`)
  }
  var query = {_user: req.params.user, _type: 'src', Package: package};
  send_extracted_file(query, `${package}/manual.pdf`, req, res, next).catch(error_cb(400, next));
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
    case `manual.html`:
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
  var query = {'_user': user, 'Package': package, '_type': 'src'};
  return packages.findOne(query).then(function(x){
    if(x) return x;
    /* try case insensitive */
    query.Package = {$regex: `^${package}$`, $options: 'i'};
    return packages.findOne(query).then(function(x){
      if(x) return x;
      throw `Package ${user}/${package} not found`;
    });
  });
}

module.exports = router;
