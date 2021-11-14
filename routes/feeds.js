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
    var cursor = packages.find({_user: user, _type: 'src','_builder.registered' : {$ne: 'false'}})
      .sort({'_builder.timestamp' : -1})
      .collation({locale: "en_US", numericOrdering: true})
      .project({
        _id: 0,
        maintainer: '$Maintainer',
        package: '$Package',
        version: '$Version',
        description: '$Description',
        updated: '$_builder.timestamp',
        vignettes: '$_builder.vignettes',
        status: '$_builder.status',
        upstream: '$_builder.upstream',
        commit: '$_builder.commit',
        buildlog: '$_builder.url',
        repository: '$Repository'
      });
    return cursor.hasNext().then(function(has_any_data){
      if(has_any_data){
        return cursor.next(); //promise to read 1 record
      }
    }).then(function(latest){
      res.set('Cache-Control', 'public, max-age=60');
      res.type('application/xml');
      var repo = 'https://' + user + '.r-universe.dev';
      var title = user + ' r-universe repository';
      var feed = xmlbuilder.begin(
        {writer: opts}, function(chunk){res.write(chunk)}
      ).dec({encoding:"UTF-8"});
      feed.
        ele('rss', {
          'version': '2.0', 
          'xmlns:atom': 'http://www.w3.org/2005/Atom',
          'xmlns:r': 'https://r-universe.dev' }).
        ele('channel')
          .ele('title', title).up()
          .ele('link', repo).up()
          .ele('description', 'Package updated in ' + user).up()
          .ele('generator', 'cranlike-server ' + version).up()
          .ele('image')
            .ele('url', 'https://github.com/' + user + '.png?size=400').up()
            .ele('title', title).up()
            .ele('link', repo).up()
          .up();
        if(latest)
          feed.ele('lastBuildDate', convert_date(latest.updated)).up();
      cursor.rewind();
      return cursor.forEach(function(pkg){
        var item = feed.ele('item');
        item.ele('title', pkg.package + ' ' + pkg.version).up();
        item.ele('author', convert_maintainer(pkg.maintainer)).up();
        item.ele('description', pkg.description).up();
        item.ele('link', pkg.buildlog).up();
        item.ele('pubDate', convert_date(pkg.updated)).up();

        /* RSS requires namespace for non-standard fields */
        item.ele('r:package', pkg.package).up();
        item.ele('r:version', pkg.version).up();
        item.ele('r:status', pkg.status).up();
        item.ele('r:repository', pkg.repository).up();
        item.ele('r:upstream', pkg.upstream).up();
        item.ele('r:commit', pkg.commit).up();
        if(pkg.vignettes && pkg.vignettes.length){
          for (const vignette of pkg.vignettes) {
            item.ele('r:article').
              ele('r:source', vignette.source).up().
              ele('r:filename', vignette.filename).up().
              ele('r:title', vignette.title).up().
              ele('r:created', vignette.created).up().
              ele('r:modified', vignette.modified).up().
              up();
          }
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
