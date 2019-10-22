var express = require('express');
var router = express.Router();

router.get('/:user', function(req, res, next) {
  res.send('Some info about user: ' + req.params.user);
});

router.get('/:user/src', function(req, res, next) {
  res.send('Source packages for: ' + req.params.user);
});

router.get('/:user/bin', function(req, res, next) {
  res.send('Binary packages for: ' + req.params.user);
});

router.get('/:user/old', function(req, res, next) {
  res.send('Archive for: ' + req.params.user);
});

router.get('/:user/old/:date', function(req, res, next) {
  res.send('Archive for: ' + req.params.user + ' on date: ' + req.params.date);
});


module.exports = router;
