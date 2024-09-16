const express = require('express');
const createError = require('http-errors');
const xmlbuilder = require('xmlbuilder');
const cheerio = require('cheerio');
const hljs = require('highlight.js');
const router = express.Router();
const tools = require("../src/tools.js");
const send_extracted_file = tools.send_extracted_file;
const tar_index_files = tools.tar_index_files;

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

// Pre-middleware for all requests:
// validate that universe or package exists, possibly fix case mismatch, otherwise 404
router.get("/:user/:package*", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  real_package_home(user, package).then(function(x){
    var realowner = x._realowner || x._user;
    if(x._user != user){
      /* nginx does not understand cross-domain redirect with relative path */
      res.redirect(req.path.replace(`/${user}/${package}`, `https://${x._user}.r-universe.dev/${x.Package}`));
    } else if(x.Package != package){
      res.redirect(req.path.replace(`/${user}/${package}`, `/${user}/${x.Package}`));
    } else if(req.params['0'] === "" && user === 'cran' && realowner !== 'cran' ) {
      /* req.params['0'] means only redirect the html dasbhoard, not pkg content */
      res.redirect(req.path.replace(`/${user}/${package}`, `https://${realowner}.r-universe.dev/${x.Package}`));
    } else {
      next();
    }
  }).catch(function(){
    return find_package(user, package, 'failure').then(function(y){
      res.status(404).type('text/plain').send(`Package ${user}/${package} exists but failed to build: ${y._buildurl}`);
    });
  }).catch(error_cb(404, next));

});

/* This endpoint should be masked by new frontend */
router.get("/:user/:package", function(req, res, next) {
  res.redirect(`/${req.params.user}/${req.params.package}/json`);
});

router.get("/:user/:package/json", function(req, res, next) {
  res.redirect(301, `/${req.params.user}/api/packages/${req.params.package}`);
});

router.get("/:user/:package/files", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var query = {_user : user, Package : package};
  packages.find(query).sort({"Built.R" : -1}).toArray().then(docs => res.send(docs)).catch(error_cb(400, next));
});

router.get("/:user/:package/buildlog", function(req, res, next) {
  var user = req.params.user;
  var package = req.params.package;
  var query = {_user : user, Package : package};
  packages.find(query).sort({"_created" : -1}).limit(1).next().then(function(x){
    console.log(x)
    res.redirect(x['_buildurl'])
  }).catch(error_cb(400, next));
});

/* Match CRAN / R dynamic help */
router.get("/:user/:package/DESCRIPTION", function(req, res, next) {
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var filename = `${package}/DESCRIPTION`;
  send_extracted_file(query, filename, req, res).catch(error_cb(400, next));
});

/* Match CRAN / R dynamic help */
router.get('/:user/:package/NEWS:ext?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var ext = req.params.ext || '.html';
  var filename = `${package}/extra/NEWS${ext}`
  send_extracted_file(query, filename, req, res).catch(error_cb(400, next));
});

/* Match CRAN */
router.get('/:user/:package/:file.pdf', function(req, res, next){
  var package = req.params.package;
  if(package != req.params.file){
    return res.status(404).send(`Did you mean ${package}.pdf`)
  }
  var query = {_user: req.params.user, _type: 'src', Package: package};
  send_extracted_file(query, `${package}/manual.pdf`, req, res).catch(error_cb(400, next));
});

/* Match CRAN */
router.get('/:user/:package/citation:ext?', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  var ext = req.params.ext || '.html';
  var filename = `${package}/extra/citation${ext}`
  send_extracted_file(query, filename, req, res).catch(error_cb(400, next));
});

function doc_path(file, package){
  switch(file.toLowerCase()) {
    case "readme.html":
      return `${package}/extra/readme.html`;
    case "readme.md":
      return `${package}/extra/readme.md`;
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
  tools.get_extracted_file(query, `${package}/extra/readme.html`).then(function(html){
    if(req.query.highlight === 'hljs'){
      const $ = cheerio.load(html, null, false);
      $('code[class^="language-"]').each(function(i, el){
        try { //hljs errors for unsupported languages
          var el = $(el)
          var lang = el.attr('class').substring(9);
          var matcher = new RegExp(`([a-z]+::)?(install_github|pak|pkg_install)\\(.${user}/${package}.\\)`, "i");
          var input = el.text().replace(matcher, `# $&\ninstall.packages("${package}", repos = c('https://${user}.r-universe.dev', 'https://cloud.r-project.org'))`)
          var out = hljs.highlight(input, {language: lang}).value
          el.addClass("hljs").empty().append(out);
        } catch (e) { }
      });
      html = $.html();
    }
    res.type('text/html; charset=utf-8').send(html);
  }).catch(error_cb(400, next));
});

/* extract single page from manual */
router.get('/:user/:package/doc/page/:id', function(req, res, next){
  var user = req.params.user;
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
        $(this).attr("href", `https://${user}.r-universe.dev/${package}/doc/manual.html` + link);
      }
    });
    el.find('hr').remove();
    res.send(el.html());
  }).catch(error_cb(400, next));
});

router.get('/:user/:package/doc', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  return packages.find(query, {limit:1}).sort({"_created" : -1}).next().then(function(x){
    if(!x)
      throw `Package ${query.Package} not found in ${query['_user']}`;
    return tar_index_files(bucket.openDownloadStream(x.MD5sum));
  }).then(function(index){
    var output = [];
    index.files.forEach(function(x){
      var m = x.filename.match(`^${package}/inst/doc/(.+)$`);
      if(m) output.push(m[1]);
    });
    res.send(output);
  }).catch(error_cb(400, next));
});

router.get('/:user/:package/doc/:file', function(req, res, next){
  var package = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: package};
  send_extracted_file(query, doc_path(req.params.file, package), req, res).catch(error_cb(400, next));
});

router.get('/:user/:package/sitemap.xml', function(req, res, next) {
  real_package_home(req.params.user, req.params.package).then(function(x){
    var xml = xmlbuilder.create('urlset', {encoding:"UTF-8"});
    xml.att('xmlns','http://www.sitemaps.org/schemas/sitemap/0.9')
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}`);
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/api/packages/${x.Package}`);
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/${x.Package}.pdf`);
    xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/doc/manual.html`);
    var assets = x._assets || [];
    if(assets.includes('extra/NEWS.html')){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/NEWS`);
    }
    if(assets.includes('extra/NEWS.txt')){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/NEWS.txt`);
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
    var vignettes = x._vignettes || [];
    vignettes.map(function(vignette){
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/${x.Package}/doc/${vignette.source}`);
      xml.ele('url').ele('loc', `https://${x['_user']}.r-universe.dev/articles/${x.Package}/${vignette.filename}`);
    });
    res.type('application/xml').send(xml.end({ pretty: true}));
  }).catch(error_cb(400, next));
});

//This redirects cran.r-universe.dev/pkg to the canonical home, if any
//Todo: allow to by pass to access resources (e.g. vignettes) from the cran copy
function real_package_home(user, package){
  //if(user === 'cran'){
  //  return packages.findOne({'Package': package, '_type': 'src', '_indexed': true}).then(function(x){
  //    if(x) return x;
  //    return find_package(user, package);
  //  });
  //} else {
    return find_package(user, package);
  //}
}

function find_package(user, package, type = 'src'){
  var nocasepkg = package.toLowerCase();
  var query = {'_user': user, '_nocasepkg': nocasepkg, '_type': type};
  return packages.findOne(query).then(function(x){
    if(x) return x;
    /* try other universes as well */
    query = {
      '_nocasepkg' : nocasepkg,
      '_type' : 'src',
      '_universes' : user
    };
    return packages.findOne(query).then(function(x){
      if(x) return x;
      throw `Package ${user}/${package} not found`;
    });
  });
}

module.exports = router;
