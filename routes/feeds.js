const express = require('express');
const createError = require('http-errors');
const xmlbuilder = require('xmlbuilder');
const router = express.Router();
const tools = require("../src/tools.js");
const { version } = require('../package.json');

const opts = { pretty: false, allowEmpty: false };

function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

function qf(x, query_by_user_or_maintainer){
  const user = x._user;
  if(user == ":any"){
    delete x._user;
  } else if(query_by_user_or_maintainer) {
    delete x._user;
    x['$or'] = [
      {'_user': user},
      {'_maintainer.login': user, '_indexed': true}
    ];
  }
  return x;
}

router.get('/:user/feed.xml', function(req, res, next) {
  var user = req.params.user;
  const query = qf({_user: user, _registered: true, _type: {$in: ['src', 'failure']}}, true);
  const limit = parseInt(req.query.limit) || 50;
  tools.test_if_universe_exists(user).then(function(x){
    if(!x) return res.type('text/plain').status(404).send('No universe for user: ' + user);
    var cursor = packages.find(query)
      .sort({'_commit.time' : -1})
      .limit(limit)
      .project({
        _id: 0,
        maintainer: '$Maintainer',
        package: '$Package',
        version: '$Version',
        description: '$Description',
        updated: '$_commit.time',
        vignettes: '$_vignettes',
        status: '$_status',
        upstream: '$_upstream',
        buildlog: '$_buildurl',
        repository: '$Repository',
        type: '$_type',
        user: '$_user'
      });
    return cursor.hasNext().then(function(has_any_data){
      if(has_any_data){
        return cursor.next(); //promise to read 1 record
      }
    }).then(function(latest){
      res.set('Cache-Control', 'public, max-age=60');
      res.type('application/xml');
      if(user == ':any'){
        var repo = 'https://r-universe.dev';
        var title = 'Updates in r-universe';
        user = 'r-universe';
      } else {
        var repo = 'https://' + user + '.r-universe.dev';
        var title = user + ' r-universe repository';
      }
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
        var pkgtitle = (pkg.type === 'failure' ? 'FAILURE: ' : '') + '[' + pkg.user + '] ' + pkg.package + ' ' + pkg.version;
        item.ele('title', pkgtitle).up();
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

router.get('/shared/sitemap_index.xml', function(req, res, next) {
  packages.distinct('_user', {_registered: true, _type: 'src'}).then(function(users){
    var xml = xmlbuilder.create('sitemapindex', {encoding:"UTF-8"});
    xml.att('xmlns','http://www.sitemaps.org/schemas/sitemap/0.9')
    users.forEach(x => xml.ele('sitemap').ele('loc', `https://${x}.r-universe.dev/sitemap_index.xml`));
    res.type('application/xml').send(xml.end({ pretty: true}));
  }).catch(error_cb(400, next));
});

router.get('/:user/sitemap.xml', function(req, res, next) {
  res.set('Cache-Control', 'max-age=3600, public').redirect(`https://${req.params.user}.r-universe.dev/sitemap_index.xml`);
});

router.get('/:user/sitemap_index.xml', function(req, res, next) {
  var user = req.params.user;
  var query = qf({_user: user, _registered: true, _type: 'src'}, true);
  return packages.find(query).sort({'Package' : 1}).project({
    _id: 0,
    package: '$Package',
    user: '$_user'
  }).toArray().then(function(docs){
    if(docs.length){
      var xml = xmlbuilder.create('sitemapindex', {encoding:"UTF-8"});
      xml.att('xmlns','http://www.sitemaps.org/schemas/sitemap/0.9')
      docs.forEach(x => xml.ele('sitemap').ele('loc', `https://${x.user}.r-universe.dev/${x.package}/sitemap.xml`));
      res.type('application/xml').send(xml.end({ pretty: true}));
    } else {
      res.status(404).send('No packages found');
    }
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
