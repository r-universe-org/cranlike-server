var express = require('express');
var router = express.Router();
router.get(new RegExp('^/(\d{4})-(\d{1,2})-(\d{1,2})'), function(req, res, next) {
  res.send('Hello this is the packages router');
});

module.exports = router;
