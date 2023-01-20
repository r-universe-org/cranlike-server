const express = require('express');
const createError = require('http-errors');
const router = express.Router();
const tools = require("../src/tools.js");
//const { version } = require('../package.json');

/* Error generator */
function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

//TODO: this is same as /landing ?
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
  test_if_package_exists(user, package).then(function(){
    if(req.path.substr(-1) != '/'){
      res.redirect(`/v2/${user}/${package}/`);
    } else {
      res.type('text/plain').send(`Package homepage ${user}/${package} here...`);
    }
  }).catch(error_cb(404, next));
});

//TODO: filter remotes??
function test_if_package_exists(user, package){
  const query = {'_user': user, 'Package': package};
  return packages.findOne(query).then(function(x){
    if(!x) {
      throw `Package ${user}/${package} not found`;
    }
    return true;
  });
}

module.exports = router;
