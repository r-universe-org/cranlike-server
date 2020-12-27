var express = require('express');
var router = express.Router();
var fs = require('fs');
var marked = require('marked');

router.get('/:user/man', function(req, res) {
  fs.readFile('./docs/api.md', function(err, data) {
    if (err) { console.log(err); throw(err); return; }

    marked(data.toString(), { 'format': 'html' }, function(err, html) {
      if (err) { console.log(err); throw(err); return; }
      res.render('man', {
        'docs': html
      })
    })
  })
})

module.exports = router;
