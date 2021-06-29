const express = require('express');
const createError = require('http-errors');
const badgen = require('badgen');
const router = express.Router();

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

/* Same as /:user/packages */
router.get('/:user/badges', function(req, res, next) {
  packages.distinct('Package', {_user : req.params.user}).then(function(x){
    res.send(x);
  }).catch(error_cb(400, next));
});

router.get('/:user/badges/:package', function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var badge = {label: 'r-universe', status: 'unavailable', color: 'red'};
  //badge.icon = 'data:image/svg+xml;base64,...';
  packages.distinct('Version', {_user : user, Package : package, _type: 'src'}).then(function(x){
    if(x.length){
      badge.status = x.join("|");
      badge.color = 'green';
    }
    var svg = badgen.badgen(badge);
    svg = svg.replace('<title>', '<a href="https://' + user + '.r-universe.dev" alt="r-universe">\n  <title>');
    svg = svg.replace('</svg>', '  </a>\n</svg>');
    res.type('image/svg+xml').send(svg);
  }).catch(error_cb(400, next));
});

module.exports = router;
