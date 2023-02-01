const express = require('express');
const createError = require('http-errors');
const xmlbuilder = require('xmlbuilder');
const router = express.Router();
const tools = require("../src/tools.js");
const send_extracted_file = tools.send_extracted_file;
const send_frontend_html = tools.send_frontend_html;
const send_frontend_js = tools.send_frontend_js;
const tablist = ['builds', 'packages', 'contributors', 'articles', 'badges'];

/* Error generator */
function error_cb(status, next) {
  return function(err){
    console.log("[Debug] HTTP " + status + ": " + err)
    next(createError(status, err));
  }
}

router.get('/:user', function(req, res, next) {
  const user = req.params.user;
  tools.test_if_universe_exists(user).then(function(exists){
    if(exists){
      res.set('Cache-control', 'private'); //html or json
      const accept = req.headers['accept'];
      if(accept && accept.includes('html')){
        res.redirect(`/${user}/builds`);
      } else {
        res.send("Welcome to the " + user + " universe!");
      }
    } else {
      res.status(404).type('text/plain').send("No universe found for user: " + user);
    }
  }).catch(error_cb(400, next));
});

/* robot.txt is not a package */
router.get('/:user/robots.txt', function(req, res, next) {
  res.type('text/plain').send(`Sitemap: https://${req.params.user}.r-universe.dev/sitemap_index.xml\n`);
});

/* Articles is now a fake endpoint for the front-end only */
router.get('/:user/articles', function(req, res, next){
  res.set('Cache-control', 'private'); //html or json
  if((req.headers['accept'] || "").includes("html")){
    return next(); //fall through to virtual dashboard
  }
  var query = qf({_user: req.params.user, _type: 'src', '_contents.vignettes' : { $exists: true }}, req.query.all);
  packages.distinct('Package', query).then(function(x){
    res.send(x);
  }).catch(error_cb(400, next));
});

router.get("/:user/articles/:package?/:filename?", function(req, res, next) {
  //should we check for existence here?
  send_frontend_html(req, res);
});

router.get("/:user/frontend/frontend.js", function(req, res, next) {
  send_frontend_js(req, res);
});

//hack to support <base href="/"> locally
router.get("/frontend/frontend.js", function(req, res, next) {
  send_frontend_js(req, res);
});

// Pre-middleware for all requests:
// validate that universe or package exists, possibly fix case mismatch, otherwise 404
router.get("/:user/:package*", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  if(tablist.includes(package)) {
    tools.test_if_universe_exists(user).then(function(x){
      if(!x) {
        throw `No universe for user: ${user}`;
      }
      next();
    }).catch(error_cb(404, next));
  } else {
    find_package(user, package).then(function(x){
      if(x._user != user){
        /* nginx does not understand cross-domain redirect with relative path */
        res.redirect(req.path.replace(`/${user}/${package}`, `https://${x._user}.r-universe.dev/${x.Package}`));
      } else if(x.Package != package){
        res.redirect(req.path.replace(`/${user}/${package}`, `/${user}/${x.Package}`));
      } else {
        next();
      }
    }).catch(error_cb(404, next));
  }
});

router.get("/:user/:package", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var accept = req.headers['accept'] || "";
  if(req.path.substr(-1) == '/'){
    res.redirect(`/${user}/${package}`);
  } else {
    send_frontend_html(req, res);
  }
});

router.get("/:user/:package/json", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  packages.find({_user : user, Package : package}).toArray().then(function(docs){
    var src = docs.find(x => x['_type'] == 'src');
    var failure = docs.find(x => x['_type'] == 'failure');
    if(failure){
      var failbuild = failure['_builder'] || {};
      src.failure = {
        commit: failbuild.commit,
        url: failbuild.url,
        date: failure._created
      }
    }
    src.binaries = docs.filter(x => x.Built).map(function(x){
      return {
        r: x.Built.R,
        os: x['_type'],
        version: x.Version,
        date: x._created,
        distro: (x['_type'] == 'linux' ? x['_builder'].distro : undefined),
        commit: (x['_builder'] && x['_builder'].commit && x['_builder'].commit.id),
        fileid: x['_fileid']
      }
    });
    return res.send(src);
  }).catch(error_cb(400, next));
});

router.get("/:user/:package/files", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var query = {_user : user, Package : package};
  packages.find(query).sort({"Built.R" : -1}).toArray().then(docs => res.send(docs)).catch(error_cb(400, next));
});

/* Match CRAN / R dynamic help */
router.get("/:user/:package/DESCRIPTION", function(req, res, next) {
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var filename = `${package}/DESCRIPTION`;
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

/* Match CRAN / R dynamic help */
router.get('/:user/:package/NEWS:ext?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var ext = req.params.ext || '.html';
  var filename = `${package}/extra/NEWS${ext}`
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

/* Match CRAN */
router.get('/:user/:package/:file.pdf', function(req, res, next){
  var package = req.params.package;
  if(package != req.params.file){
    return res.status(404).send(`Did you mean ${package}.pdf`)
  }
  var query = {_user: req.params.user, _type: 'src', Package: package};
  send_extracted_file(query, `${package}/manual.pdf`, req, res, next).catch(error_cb(400, next));
});

/* Match CRAN */
router.get('/:user/:package/citation:ext?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var ext = req.params.ext || '.html';
  var filename = `${package}/extra/citation${ext}`
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

// TODO: move all these files under /inst/doc at build time?
function doc_path(file, package){
  switch(file.toLowerCase()) {
    case "readme":
    case "readme.html":
      return `${package}/readme.html`;
    case "readme.md":
      return `${package}/readme.md`;
    case `manual.html`:
      return `${package}/extra/${package}.html`;
    default:
      return `${package}/inst/doc/${file}`;
  }
}

router.get('/:user/:package/doc/:file?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var file = req.params.file;
  var filename = file ? doc_path(file, package) : new RegExp(`^${package}/inst/doc/(.+)$`);
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

router.get('/:user/:package/sitemap.xml', function(req, res, next) {
  find_package(req.params.user, req.params.package).then(function(x){
    var xml = xmlbuilder.create('urlset', {encoding:"UTF-8"});
    xml.att('xmlns','http://www.sitemaps.org/schemas/sitemap/0.9')
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}`);
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/json`);
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/${x.Package}.pdf`);
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/doc/manual.html`);
    var assets = x['_contents'] && x['_contents'].assets || [];
    if(assets.includes('extra/NEWS.html')){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/doc/NEWS`);
    }
    if(assets.includes('extra/NEWS.txt')){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/doc/NEWS.txt`);
    }
    if(assets.includes('extra/citation.html')){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/citation`);
    }
    if(assets.includes('extra/citation.txt')){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/citation.txt`);
    }
    if(assets.includes('extra/citation.cff')){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/citation.cff`);
    }
    var vignettes = x['_contents'] && x['_contents'].vignettes || [];
    vignettes.map(function(vignette){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/doc/${vignette.source}`);
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/doc/${vignette.filename}`);
    });
    res.type('application/xml').send(xml.end({ pretty: true}));
  }).catch(error_cb(400, next));
});

function find_package(user, package){
  var query = {'_user': user, 'Package': package, '_type': 'src'};
  return packages.findOne(query).then(function(x){
    if(x) return x;
    /* try case insensitive */
    query = {
      Package : {$regex: `^${package}$`, $options: 'i'},
      '_type' : 'src',
      '$or' : [
        {'_user': user},
        {'_builder.maintainer.login': user, '_selfowned': true}
      ]
    };
    return packages.findOne(query).then(function(x){
      if(x) return x;
      throw `Package ${user}/${package} not found`;
    });
  });
}

module.exports = router;
