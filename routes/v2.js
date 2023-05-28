const express = require('express');
const createError = require('http-errors');
const xmlbuilder = require('xmlbuilder');
const cheerio = require('cheerio');
const hljs = require('highlight.js');
const router = express.Router();
const tools = require("../src/tools.js");
const send_extracted_file = tools.send_extracted_file;
const send_frontend_html = tools.send_frontend_html;
const send_frontend_js = tools.send_frontend_js;
const group_package_data = tools.group_package_data;
const tablist = ['builds', 'packages', 'contributors', 'articles', 'badges', 'snapshot', 'api'];

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
    res.send(group_package_data(docs));
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

/* processed html-snipped (not a full doc) */
router.get('/:user/:package/doc/readme', function(req, res, next){
  var user = req.params.user;
  var package = req.params.package;
  var query = {_user: user, _type: 'src', Package: package};
  tools.get_extracted_file(query, `${package}/readme.html`).then(function(html){

    if(req.query.highlight === 'hljs'){
      const $ = cheerio.load(html, null, false);
      $('code[class^="language-"]').each(function(i, el){
        try { //hljs errors for unsupported languages
          var el = $(el)
          var lang = el.attr('class').substring(9);
          var matcher = new RegExp(`([a-z]+::)?install_github\\(.${user}/${package}.\\)`)
          var input = el.text().replace(matcher, `# $&\ninstall.packages("${package}", repos = c('https://${user}.r-universe.dev', 'https://cloud.r-project.org'))`)
          var out = hljs.highlight(input, {language: lang}).value
          el.addClass("hljs").empty().append(out);
        } catch (e) { }
      });
      html = $.html();
    }
    res.send(html);
  }).catch(error_cb(400, next));
});

/* extract single page from manual */
router.get('/:user/:package/doc/page/:id', function(req, res, next){
  var page = req.params.id;
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  tools.get_extracted_file(query, `${package}/extra/${package}.html`).then(function(html){
    const $ = cheerio.load(html, null, false);
    const el = $(`#${page.replace(".", "\\.")}`);
    el.find(".help-page-title").replaceWith(el.find(".help-page-title h2"));
    el.find('a').each(function(i, elm) {
      var link = $(this).attr("href");
      if(link && link.charAt(0) == '#'){
        $(this).attr("href", "../manual.html" + link);
      }
    });
    el.find('hr').remove();
    res.send(el.html());
  }).catch(error_cb(400, next));
});

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
        {'_owner': user, '_selfowned': true}, //legacy redirect for gitlab-xyz owned packages
        {'_builder.maintainer.login': user, '_selfowned': true} // for gitlab-xyz or /cran mirror packages
      ]
    };
    return packages.findOne(query).then(function(x){
      if(x) return x;
      throw `Package ${user}/${package} not found`;
    });
  });
}

module.exports = router;
