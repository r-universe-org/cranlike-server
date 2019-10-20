var express = require('express');
var router = express.Router();
router.post('/:user', function(req, res, next) {
  res.send('Hello this is the submit router for:' + req.params.user);
});

module.exports = router;
