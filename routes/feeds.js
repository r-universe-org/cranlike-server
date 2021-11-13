const express = require('express');
const createError = require('http-errors');
const xmlbuilder = require('xmlbuilder');
const router = express.Router();
const tools = require("../src/tools.js");
const { version } = require('../package.json');

const opts = { pretty: false, allowEmpty: false };

function error_cb(status, next) {
  return function(err) {
    next(createError(status, err));
  }
}

router.get('/:user/index.xml', function(req, res, next) {
  const user = req.params.user
  tools.test_if_universe_exists(user).then(function(x){
    if(!x) return res.type('text/plain').status(404).send('No universe for user: ' + user);
    var cursor = packages.find({_user: user, _type: 'src'}).project({
      _id: 0,
      maintainer: '$Maintainer',
      package: '$Package',
      version: '$Version',
      description: '$Description',
      timestamp: '$_builder.timestamp',
      vignettes: '$_builder.vignettes',
      status: '$_builder.status',
      upstream: '$_builder.upstream',
      repository: '$Repository'
    }).sort({updated : -1});
    return cursor.hasNext().then(function(has_any_data){
      if(has_any_data){
        return cursor.next(); //promise to read 1 record
      }
    }).then(function(latest){
      res.set('Cache-Control', 'public, max-age=60');
      res.type('application/xml');
      var feed = xmlbuilder.begin(
        {writer: opts}, function(chunk){res.write(chunk)}
      ).dec({encoding:"UTF-8"});
      feed.
        ele('rss', {
          'version': '2.0', 
          'xmlns:atom': 'http://www.w3.org/2005/Atom',
          'xmlns:r': 'https://r-universe.dev' }).
        ele('channel')
          .ele('title', user).up()
          .ele('link', 'https://' + user + '.r-universe.dev').up()
          .ele('description', 'Packages from ' + user).up()
          .ele('generator', 'cranlike-server ' + version).up();
        if(latest)
          feed.ele('lastBuildDate', convert_date(latest.timestamp)).up();
      cursor.rewind();
      return cursor.forEach(function(pkg){
        var item = feed.ele('item');
        item.ele('title', pkg.package + ' ' + pkg.version).up();
        item.ele('author', convert_maintainer(pkg.maintainer)).up();
        item.ele('description', pkg.description).up();
        item.ele('link', pkg.upstream).up();
        item.ele('pubDate', convert_date(pkg.timestamp)).up();

        /* RSS requires namespace for non-standard fields */
        item.ele('r:package', pkg.package).up();
        item.ele('r:version', pkg.version).up();
        item.ele('r:status', pkg.status).up();
        item.ele('r:repository', pkg.repository).up();
        if(pkg.vignettes && pkg.vignettes.length){
          item.ele('r:articles');
          for (const vignette of pkg.vignettes) {
            item.ele('vignette').
              ele('source', vignette.source).up().
              ele('filename', vignette.filename).up().
              ele('title', vignette.title).up().
              ele('created', vignette.created).up().
              ele('modified', vignette.modified).up().
              up();
          }
          item.up();
        }
        item.up();
      }).finally(function(){
        feed.end();
        res.end();
      });
     });
  }).catch(error_cb(400, next));
});

function convert_date(timestamp){
  console.log(timestamp)
  if(!timestamp) return;
  const date = new Date(parseInt(timestamp)*1000);
  if(!date) return;
  return date.toUTCString();
}

function convert_maintainer(str){
  const re = /^(.+)<(.*)>$/;
  const found = str.match(re);
  if(found && found.length > 1)
    return found[2].trim() + " (" + found[1].trim() + ")";
  return str;
}

module.exports = router;
