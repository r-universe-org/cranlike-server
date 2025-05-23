import express from 'express';
import createError from 'http-errors';
import hljs from 'highlight.js';
import {load as cheerio_load} from 'cheerio';
import {send_extracted_file, tar_index_files, test_if_universe_exists, get_extracted_file} from '../src/tools.js';
import {packages, bucket} from '../src/db.js';

const router = express.Router();

router.get('/:user', function(req, res, next) {
  const user = req.params.user;
  return test_if_universe_exists(user).then(function(exists){
    if(exists){
      res.vary('Accept'); //html or json
      res.set('Cache-control', 'private') // Vary does not work in cloudflare currently
      const accept = req.headers['accept'];

      //req.accepts("html") does not help because it also matches */*
      if(accept && accept.includes('html')){
        res.redirect(`/${user}/builds`);
      } else {
        res.send("Welcome to the " + user + " universe!");
      }
    } else {
      res.status(404).type('text/plain').send("No universe found for user: " + user);
    }
  });
});

/* robot.txt is not a package */
router.get('/:user/robots.txt', function(req, res, next) {
  res.type('text/plain').send(`Sitemap: https://${req.params.user}.r-universe.dev/sitemap_index.xml\n`);
});

// Pre-middleware for all requests:
// validate that universe or package exists, possibly fix case mismatch, otherwise 404
router.get("/:user/:package{/*path}", function(req, res, next) {
  var user = req.params.user;
  var pkgname = req.params.package;
  return real_package_home(user, pkgname).then(function(x){
    var realowner = x._realowner || x._user;
    if(x._user != user){
      /* nginx does not understand cross-domain redirect with relative path */
      res.redirect(req.path.replace(`/${user}/${pkgname}`, `https://${x._user}.r-universe.dev/${x.Package}`));
    } else if(x.Package != pkgname){
      res.redirect(req.path.replace(`/${user}/${pkgname}`, `/${user}/${x.Package}`));
    } else if(!req.params.path && user === 'cran' && realowner !== 'cran' ) {
      /* req.params['0'] means only redirect the html dasbhoard, not pkg content */
      res.redirect(req.path.replace(`/${user}/${pkgname}`, `https://${realowner}.r-universe.dev/${x.Package}`));
    } else {
      next();
    }
  }).catch(function(){
    return find_package(user, pkgname, 'failure').then(function(y){
      res.status(404).type('text/plain').send(`Package ${user}/${pkgname} exists but failed to build: ${y._buildurl}`);
    });
  }).catch(err => {throw createError(404, err)});
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
  var pkgname = req.params.package;
  var query = {_user : user, Package : pkgname};
  return packages.find(query).sort({"Built.R" : -1}).toArray().then(docs => res.send(docs));
});

router.get("/:user/:package/buildlog", function(req, res, next) {
  var user = req.params.user;
  var pkgname = req.params.package;
  var query = {_user : user, Package : pkgname};
  return packages.find(query).sort({"_created" : -1}).limit(1).next().then(function(x){
    console.log(x)
    res.redirect(x['_buildurl'])
  });
});

/* Match CRAN / R dynamic help */
router.get("/:user/:package/DESCRIPTION", function(req, res, next) {
  var pkgname = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: pkgname};
  var filename = `${pkgname}/DESCRIPTION`;
  return send_extracted_file(query, filename, req, res);
});

/* Match CRAN / R dynamic help */
router.get('/:user/:package/NEWS{:ext}', function(req, res, next){
  var pkgname = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: pkgname};
  var ext = req.params.ext || '.html';
  var filename = `${pkgname}/extra/NEWS${ext}`
  return send_extracted_file(query, filename, req, res);
});

/* Match CRAN */
router.get('/:user/:package/:file.pdf', function(req, res, next){
  var pkgname = req.params.package;
  if(pkgname != req.params.file)
    throw createError(404, `File not found (did you mean ${pkgname}.pdf?)`);
  var query = {_user: req.params.user, _type: 'src', Package: pkgname};
  return send_extracted_file(query, `${pkgname}/manual.pdf`, req, res);
});

/* Match CRAN */
router.get('/:user/:package/citation{:ext}', function(req, res, next){
  var pkgname = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: pkgname};
  var ext = req.params.ext || '.html';
  var filename = `${pkgname}/extra/citation${ext}`
  return send_extracted_file(query, filename, req, res);
});

function doc_path(file, pkgname){
  switch(file.toLowerCase()) {
    case "readme.html":
      return `${pkgname}/extra/readme.html`;
    case "readme.md":
      return `${pkgname}/extra/readme.md`;
    case `manual.html`:
      return `${pkgname}/extra/${pkgname}.html`;
    default:
      return `${pkgname}/inst/doc/${file}`;
  }
}

/* processed html-snipped (not a full doc) */
router.get('/:user/:package/doc/readme', function(req, res, next){
  var user = req.params.user;
  var pkgname = req.params.package;
  var query = {_user: user, _type: 'src', Package: pkgname};
  return get_extracted_file(query, `${pkgname}/extra/readme.html`).then(function(html){
    if(req.query.highlight === 'hljs'){
      const $ = cheerio_load(html, null, false);
      $('code[class^="language-"]').each(function(i, el){
        try { //hljs errors for unsupported languages
          var el = $(el)
          var lang = el.attr('class').substring(9);
          var matcher = new RegExp(`([a-z]+::)?(install_github|pak|pkg_install)\\(.${user}/${pkgname}.\\)`, "i");
          var input = el.text().replace(matcher, `# $&\ninstall.packages("${pkgname}", repos = c('https://${user}.r-universe.dev', 'https://cloud.r-project.org'))`)
          var out = hljs.highlight(input, {language: lang}).value
          el.addClass("hljs").empty().append(out);
        } catch (e) { }
      });
      html = $.html();
    }
    res.type('text/html; charset=utf-8').send(html);
  });
});

/* extract single page from manual */
router.get('/:user/:package/doc/page/:id', function(req, res, next){
  var user = req.params.user;
  var page = req.params.id;
  var pkgname = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: pkgname};
  return get_extracted_file(query, `${pkgname}/extra/${pkgname}.html`).then(function(html){
    const $ = cheerio_load(html, null, false);
    const el = $(`#${page.replace(".", "\\.")}`);
    el.find(".help-page-title").replaceWith(el.find(".help-page-title h2"));
    el.find('a').each(function(i, elm) {
      var link = $(this).attr("href");
      if(link && link.charAt(0) == '#'){
        $(this).attr("href", `https://${user}.r-universe.dev/${pkgname}/doc/manual.html` + link);
      }
    });
    el.find('hr').remove();
    res.send(el.html());
  });
});

router.get('/:user/:package/doc', function(req, res, next){
  var pkgname = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: pkgname};
  return packages.find(query, {limit:1}).sort({"_created" : -1}).next().then(function(x){
    if(!x)
      throw `Package ${query.Package} not found in ${query['_user']}`;
    return tar_index_files(bucket.openDownloadStream(x._fileid));
  }).then(function(index){
    var output = [];
    index.files.forEach(function(x){
      var m = x.filename.match(`^${pkgname}/inst/doc/(.+)$`);
      if(m) output.push(m[1]);
    });
    res.send(output);
  });
});

router.get('/:user/:package/doc/:file', function(req, res, next){
  var pkgname = req.params.package;
  var query = {_user: req.params.user, _type: 'src', Package: pkgname};
  return send_extracted_file(query, doc_path(req.params.file, pkgname), req, res);
});

//This redirects cran.r-universe.dev/pkg to the canonical home, if any
//Todo: allow to by pass to access resources (e.g. vignettes) from the cran copy
function real_package_home(user, pkgname){
  //if(user === 'cran'){
  //  return packages.findOne({'Package': package, '_type': 'src', '_indexed': true}).then(function(x){
  //    if(x) return x;
  //    return find_package(user, package);
  //  });
  //} else {
    return find_package(user, pkgname);
  //}
}

function find_package(user, pkgname, type = 'src'){
  var nocasepkg = pkgname.toLowerCase();
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
      throw `Package ${user}/${pkgname} not found`;
    });
  });
}

export default router;
