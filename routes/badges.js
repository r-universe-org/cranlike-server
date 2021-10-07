const express = require('express');
const createError = require('http-errors');
const badgen = require('badgen');
const router = express.Router();
const tools = require("../src/tools.js");

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function send_badge(badge, user, res){
  var svg = badgen.badgen(badge);
  svg = svg.replace('<title>', '<a href="https://' + user + '.r-universe.dev" alt="r-universe">\n  <title>');
  svg = svg.replace('</svg>', '  </a>\n</svg>');
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=60').send(svg);
}

router.get('/:user/badges', function(req, res, next) {
  packages.distinct('Package', {_user : req.params.user, '_builder.registered' : {$ne: 'false'}}).then(function(x){
    x.push(":name")
    x.push(":total");
    res.send(x);
  }).catch(error_cb(400, next));
});

router.get('/:user/badges/::meta', function(req, res, next) {
  var user = req.params.user;
  var color = req.query.color;
  var badge = {
    label: 'r-universe',
    color: color || 'blue',
    style: req.query.style,
    scale: req.query.scale
  };
  tools.test_if_universe_exists(user).then(function(x){
    if(!x) return res.type('text/plain').send(404, 'No universe for user: ' + user);
    if(req.params.meta == 'name'){
      badge.status = user;
      send_badge(badge, user, res);
    } else if(req.params.meta == 'total'){
      return packages.distinct('Package', {_user : user, _type: 'src', '_builder.registered' : {$ne: 'false'}}).then(function(x){
        badge.status = x.length + " packages";
        send_badge(badge, user, res);
      });
    } else {
      throw "Unsupported badge type :" + req.params.meta;
    }
  }).catch(error_cb(400, next));
});

router.get('/:user/badges/:package', function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var color = req.query.color;
  var badge = {
    label: 'r-universe',
    status: 'unavailable',
    color: color || 'red',
    style: req.query.style,
    scale: req.query.scale
  };
  //badge.icon = 'data:image/svg+xml;base64,...';
  packages.distinct('Version', {_user : user, Package : package, _type: 'src', '_builder.registered' : {$ne: 'false'}}).then(function(x){
    if(x.length){
      badge.status = x.join("|");
      badge.color = color || 'green';
    }
    send_badge(badge, user, res);
  }).catch(error_cb(400, next));
});

module.exports = router;
