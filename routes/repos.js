/* Packages */
const express = require('express');
const createError = require('http-errors');
const zlib = require('zlib');
const tar = require('tar-stream');
const mime = require('mime');
const router = express.Router();

/* Fields included in PACKAGES indices */
/* To do: once DB is repopulated, we can remove Imports, Suggests, etc in favor of _dependencies */
const pkgfields = {_id: 1, _hard_deps: 1, _soft_deps: 1, Package: 1, Version: 1, Depends: 1, Suggests: 1, License: 1,
  NeedsCompilation: 1, Imports: 1, LinkingTo: 1, Enhances: 1, License_restricts_use: 1,
  OS_type: 1, Priority: 1, License_is_FOSS: 1, Archs: 1, Path: 1, MD5sum: 1, Built: 1};

function error_cb(status, next) {
  return function(err) {
    next(createError(status, err));
  }
}

function dep_to_string(x){
  if(x.package && x.version){
    return x.package + " (" + x.version + ")";
  } else if(x.package) {
    return x.package
  } else {
    return x;
  }
}

function unpack_deps(x){
  var hard_deps = x['_hard_deps'] || [];
  var soft_deps = x['_soft_deps'] || [];
  var alldeps = hard_deps.concat(soft_deps);
  var deptypes = new Set(alldeps.map(dep => dep.role));
  deptypes.forEach(function(type){
    x[type] = alldeps.filter(dep => dep.role == type);
  });
  delete x['_hard_deps'];
  delete x['_soft_deps'];
  return x;
}

function doc_to_dcf(doc){
  var x = unpack_deps(doc);
  delete x['_id'];
  let keys = Object.keys(x);
  return keys.map(function(key){
    let val = x[key];
    if(Array.isArray(val))
      val = val.map(dep_to_string).join(", ");
    else if(key == 'Built')
      val = "R " + Object.values(val).join("; ");
    return key + ": " + val.replace(/\s/gi, ' ');
  }).join("\n") + "\n\n";
}

function doc_to_ndjson(x){
  return JSON.stringify(x) + '\n';
}

function doc_to_filename(x){
  const ext = {
    src: ".tar.gz",
    win: ".zip",
    mac: ".tgz"
  };
  return x.Package + "_" + x.Version + ext[x['_type']] + '\n';
}

function etagify(x){
  return 'W/"' +  x + '"';
}

function qf(x, query_by_user_or_maintainer){
  const user = x._user;
  if(user == ":any"){
    delete x._user;
    if(query_by_user_or_maintainer){
      x['_selfowned'] = true;
    }
  } else if(query_by_user_or_maintainer) {
    delete x._user;
    x['$or'] = [
      {'_user': user},
      {'_builder.maintainer.login': user, '_selfowned': true}
    ];
  }
  return x;
}

function packages_index(query, format, req, res, next){
  if(format && format !== 'gz' && format !== 'json'){
    return next(createError(404, 'Unsupported PACKAGES format: ' + format));
  }
  var cursor = packages.find(query).project(pkgfields).sort({"_id" : -1});
  cursor.hasNext().then(function(has_any_data){
    /* Cache disabled until we solve _id bug */
    if(0 && has_any_data){
      return cursor.next(); //promise to read 1st record
    }
  }).then(function(doc){
    if(doc){
      var etag = etagify(doc['_id']);
      if(etag === req.header('If-None-Match')){
        cursor.close();
        res.status(304).send();
        return; //DONE!
      } else {
        /* Jeroen: the next() / rewind() here seems to trigger a warning/ bug in the mongo driver:
           Field 'cursors' contains an element that is not of type long: 0 */
        cursor.rewind();
        res.set('ETag', etag);
      }
    }
    res.set('Cache-Control', 'no-cache');
    if(!format){
      cursor
        .transformStream({transform: doc_to_dcf})
        .pipe(res.type('text/plain'));
    } else if(format == 'gz'){
      cursor
        .transformStream({transform: doc_to_dcf})
        .pipe(zlib.createGzip())
        .pipe(res.type('application/x-gzip'));
    } else if(format == 'json'){
      cursor
        .transformStream({transform: doc_to_ndjson})
        .pipe(res.type('text/plain'));
    } else {
      cursor.close();
      next(createError(404, 'Unknown PACKAGES format: ' + format));
    }
  }).catch(error_cb(400, next));
}

function html_index(query, res){
  packages
    .find(query)
    .project({_id:0, Package:1, Version:1, _type:1})
    .transformStream({transform: doc_to_filename})
    .pipe(res.type('text/plain'));
}

function count_by_user(){
  return packages.aggregate([
    {$group:{_id: "$_user", count: { $sum: 1 }}}
  ])
  .project({_id: 0, user: "$_id", count: 1})
  .transformStream({transform: doc_to_ndjson});
}

function count_by_type(user){
  return packages.aggregate([
    {$match: qf({_user: user})},
    {$group:{_id: "$_type", count: { $sum: 1 }}}
  ])
  .project({_id: 0, type: "$_id", count: 1})
  .transformStream({transform: function(x){
    const dirname = {
      src : 'src/contrib',
      win : 'bin/windows/contrib',
      mac : 'bin/macosx/contrib/'
    };
    x.path = dirname[x.type];
    return doc_to_ndjson(x);
  }});
}

function count_by_built(user, type){
  return packages.aggregate([
    {$match: {_user: user, _type : type}},
    {$group:{_id: {R: "$Built.R", Platform: "$Built.Platform"}, count: { $sum: 1 }}}
  ])
  .project({_id: 0, R: "$_id.R", Platform:"$_id.Platform", count: 1})
  .transformStream({transform: doc_to_ndjson});
}

function send_binary(query, filename, req, res, next){
  packages.findOne(query, {project: {MD5sum: 1, Redirect: 1}}).then(function(docs){
    if(!docs){
      next(createError(404, 'Package not found'));
    } else {
      var hash = docs.MD5sum;
      var etag = etagify(hash);
      if(etag === req.header('If-None-Match')){
        res.status(304).send();
      } else if(req.query.nocdn) {
        return bucket.find({_id: hash}, {limit:1}).next().then(function(x){
          if (!x)
            throw `Failed to locate file in gridFS: ${hash}`;
          let type = x.filename.endsWith('.zip') ? 'application/zip' : 'application/x-gzip';
          return bucket.openDownloadStream(x['_id']).pipe(
            res.type(type).set("ETag", etag).set('Content-Length', x.length)
          );
        });
      } else {
        const host = req.headers.host || "";
        const cdn = host === 'localhost:3000' ? '/cdn' : 'https://cdn.r-universe.dev';
        res.set("ETag", etag).redirect(`${cdn}/${hash}/${filename}`);
      }
    }
  }).catch(error_cb(400, next));  
}

/* See https://www.npmjs.com/package/tar-stream#Extracting */
function tar_stream_file(hash, res, filename){
  var input = bucket.openDownloadStream(hash);
  var gunzip = zlib.createGunzip();
  return new Promise(function(resolve, reject) {

    /* callback to extract single file from tarball */
    function process_entry(header, filestream, next_file) {
      if(!dolist && !hassent && header.name === filename){
        filestream.on('end', function(){
          hassent = true;
          resolve(filename);
          input.destroy(); // close mongo stream prematurely, is this safe?
        }).pipe(
          res.type(mime.getType(filename) || 'text/plain').set("ETag", hash).set('Content-Length', header.size)
        );
      } else {
        if(dolist && header.name){
          let m = header.name.match(filename);
          if(m && m.length){
            matches.push(m.pop());
          }
        }
        filestream.resume(); //drain the file
      }
      next_file(); //ready for next entry
    }

    /* callback at end of tarball */
    function finish_stream(){
      if(dolist){
        res.send(matches);
        resolve(matches);
      } else if(!hassent){
        reject(`No such file: ${filename}`);
      }
    }

    var dolist = filename instanceof RegExp;
    var matches = [];
    var hassent = false;
    var extract = tar.extract()
      .on('entry', process_entry)
      .on('finish', finish_stream);
    input.pipe(gunzip).pipe(extract);
  }).finally(function(){
    gunzip.destroy();
    input.destroy();
  });
}

function send_extracted_file(query, filename, req, res, next){
  return packages.findOne(query).then(function(x){
    if(!x){
      next(createError(404, 'Package not found'));
    } else {
      var hash = x.MD5sum;
      var etag = etagify(hash);
      if(etag === req.header('If-None-Match')){
        res.status(304).send();
      } else {
        return bucket.find({_id: hash}, {limit:1}).hasNext().then(function(x){
          if(!x)
            throw `Failed to locate file in gridFS: ${hash}`;
          return tar_stream_file(hash, res, filename);
        });
      }
    }
  });
}

function find_by_user(_user, _type){
  var out = {};
  if(_user != ':any')
    out._user = _user;
  if(_type)
    out_type = _type;
  return out;
}

/* Use negative match, because on packages without compiled code Built.Platform is empty */
function arch_to_built(xcode){
  return (xcode && xcode.match("arm64")) ? {$not : /x86_64/} : {$not : /aarch64/ };
}

/* Copied from api.js */
router.get('/', function(req, res, next) {
  count_by_user().pipe(res);
});

router.get('/:user', function(req, res, next) {
  count_by_type(req.params.user).pipe(res);
});

router.get('/:user/src', function(req, res, next) {
  res.redirect('/' + req.params.user + '/src/contrib');
});

router.get('/:user/bin', function(req, res, next) {
  count_by_type(req.params.user).pipe(res);
});

router.get('/:user/bin/windows', function(req, res, next) {
  res.redirect('/' + req.params.user + '/bin/windows/contrib');
});

router.get('/:user/bin/macosx', function(req, res, next) {
  res.redirect('/' + req.params.user + '/bin/macosx/contrib');
});

/* CRAN-like index for source packages */
router.get('/:user/src/contrib/PACKAGES\.:ext?', function(req, res, next) {
  packages_index(qf({_user: req.params.user, _type: 'src'}), req.params.ext, req, res, next);
});

router.get('/:user/src/contrib/', function(req, res, next) {
  packages_index(qf({_user: req.params.user, _type: 'src'}), 'json', req, res, next);
});

/* CRAN-like index for Windows packages */
router.get('/:user/bin/windows/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}});
  packages_index(query, req.params.ext, req, res, next);
});

router.get('/:user/bin/windows/contrib/:built/', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}});
  packages_index(query, 'json', req, res, next);
});

/* CRAN-like index for MacOS packages */
router.get('/:user/bin/macosx/:xcode?/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}});
  query['Built.Platform'] = arch_to_built(req.params.xcode);
  packages_index(query, req.params.ext, req, res, next);
});

router.get('/:user/bin/macosx/:xcode?/contrib/:built/', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}});
  query['Built.Platform'] = arch_to_built(req.params.xcode);
  packages_index(query, 'json', req, res, next);
});

/* Index available R builds for binary pkgs */
router.get('/:user/bin/windows/contrib', function(req, res, next) {
  count_by_built(req.params.user, 'win').pipe(res);
});

router.get('/:user/bin/macosx/:xcode?/contrib', function(req, res, next) {
  count_by_built(req.params.user, 'mac').pipe(res);
});

/* Download package files */
router.get('/:user/src/contrib/:pkg.tar.gz', function(req, res, next) {
  var pkg = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'src', Package: pkg[0], Version: pkg[1]});
  send_binary(query, `${req.params.pkg}.tar.gz`, req, res, next);
});

router.get('/:user/bin/windows/contrib/:built/:pkg.zip', function(req, res, next) {
  var pkg = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg[0], Version: pkg[1]});
  send_binary(query, `${req.params.pkg}.zip`, req, res, next);
});

router.get('/:user/bin/macosx/:xcode?/contrib/:built/:pkg.tgz', function(req, res, next) {
  var pkg = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg[0], Version: pkg[1]});
  query['Built.Platform'] = arch_to_built(req.params.xcode);
  send_binary(query, `${req.params.pkg}.tgz`, req, res, next);
});

/* For now articles are only vignettes */
router.get('/:user/articles', function(req, res, next){
  var query = qf({_user: req.params.user, _type: 'src', '_builder.vignettes' : { $exists: true }}, req.query.all);
  packages.distinct('Package', query).then(function(x){
    res.send(x);
  }).catch(error_cb(400, next));
});

/* Send individual docs files */
router.get('/:user/articles/:pkg/:file?', function(req, res, next){
  var pkg = req.params.pkg;
  var query = qf({_user: req.params.user, _type: 'src', Package: pkg});
  var prefix = pkg + "/inst/doc/";
  var filename = req.params.file ? (prefix + req.params.file) : new RegExp('^' + prefix + "(.+)$");
  send_extracted_file(query, filename, req, res, next).catch(error_cb(400, next));
});

/* Send 'citation.cff' file */
router.get('/:user/citation/:pkg.cff', function(req, res, next){
  var pkg = req.params.pkg;
  var query = qf({_user: req.params.user, _type: 'src', Package: pkg});
  send_extracted_file(query, pkg + '/citation.cff', req, res, next).catch(error_cb(400, next));
});

/* Send pdf reference manual */
router.get('/:user/manual/:pkg.pdf', function(req, res, next){
  var pkg = req.params.pkg;
  var query = qf({_user: req.params.user, _type: 'src', Package: pkg});
  send_extracted_file(query, pkg + '/manual.pdf', req, res, next).catch(error_cb(400, next));
});

router.get("/:user/stats/vignettes", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 200;
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src', '_builder.vignettes' : {$exists: true}}, req.query.all)},
    {$sort : {'_builder.commit.time' : -1}},
    {$limit : limit},
    {$project: {
      _id: 0,
      user: '$_user',
      package: '$Package',
      version: '$Version',
      maintainer: '$Maintainer',
      universe: '$_user',
      pkglogo: '$_builder.pkglogo',
      upstream: '$_builder.upstream',
      login: '$_builder.maintainer.login',
      published: '$_builder.commit.time',
      vignette: '$_builder.vignettes'
    }},
    {$unwind: '$vignette'}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Public aggregated data (these support :any users)*/
router.get('/:user/stats/descriptions', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'src', _registered : true}, req.query.all);
  var cursor = packages.find(query).sort({"_builder.commit.time" : -1}).project({_id:0, _type:0});
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Failures(these support :any users)*/
router.get('/:user/stats/failures', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'failure'}, req.query.all);
  var cursor = packages.find(query).sort({"_id" : -1}).project({_id:0, _type:0});
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Public aggregated data (these support :any users)*/
router.get('/:user/stats/checks', function(req, res, next) {
  var user = req.params.user;
  var limit = parseInt(req.query.limit) || 500;
  var query = qf({_user: user}, req.query.all);
  if(req.query.maintainer)
    query.Maintainer = {$regex: req.query.maintainer, $options: 'i'};
  var cursor = packages.aggregate([
    {$match: query},
    {$group : {
      _id : { package:'$Package', version:'$Version', user: '$_user', maintainer: '$Maintainer'},
      timestamp: { $max : "$_builder.commit.time" },
      registered: { $first: "$_registered" },
      os_restriction: { $addToSet: '$OS_type'},
      runs : { $addToSet: { type: "$_type", builder: "$_builder", built: '$Built', date:'$_published'}}
    }},
    /* NB: sort+limit requires buffering, maybe not a good idea? */
    {$sort : {timestamp : -1}},
    {$limit : limit},
    {$project: {
      _id: 0, 
      user: '$_id.user', 
      maintainer:'$_id.maintainer', 
      package: '$_id.package', 
      version:'$_id.version',
      os_restriction:{ $first: "$os_restriction" },
      timestamp: 1,
      registered: 1,
      runs: 1
    }}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

function days_ago(n){
  var now = new Date();
  return now.getTime()/1000 - (n*60*60*24);
}

router.get('/:user/stats/builds', function(req, res, next) {
  var user = req.params.user;
  var query = qf({_user: user}, req.query.all);
  if(user == ":any"){
    query['_builder.commit.time'] = {'$gt': days_ago(parseInt(req.query.days) || 7)};
  }
  var cursor = packages.aggregate([
    {$match: query},
    {$group : {
      _id : { user: '$_user', package: '$Package', commit: '$_builder.commit.id'},
      version: { $first : "$Version" },
      maintainer: { $first : "$_builder.maintainer.name" },
      maintainerlogin: { $first : "$_builder.maintainer.login" },
      timestamp: { $first : "$_builder.commit.time" },
      upstream: { $first : "$_builder.upstream" },
      registered: { $first: "$_registered" },
      os_restriction: { $addToSet: '$OS_type'},
      sysdeps: { $addToSet: '$_builder.sysdeps'},
      pkgdocs: { $addToSet : '$_builder.pkgdocs' },
      runs : { $addToSet:
        { type: "$_type", built: '$Built', date:'$_published', url: '$_builder.url', status: '$_builder.status', distro: '$_builder.distro'}
      }
    }},
    {$sort : {"timestamp" : -1}},
    {$project: {
      _id: 0,
      user: '$_id.user',
      package: '$_id.package',
      commit: '$_id.commit',
      maintainer: 1,
      maintainerlogin: 1,
      version: 1,
      timestamp: 1,
      registered: 1,
      runs: 1,
      upstream: 1,
      pkgdocs: { $first: "$pkgdocs" },
      sysdeps: { $first: "$sysdeps" },
      os_restriction:{ $first: "$os_restriction" }
    }}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* This API is mostly superseded by /stats/maintainers below */
router.get("/:user/stats/pkgsbymaintainer", function(req, res, next) {
  var query = {_user: req.params.user, _type: 'src', _registered : true};
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$project: {
      _id: 0,
      package: '$Package',
      user: '$_user',
      login: '$_builder.maintainer.login',
      orcid: '$_builder.maintainer.orcid',
      name: '$_builder.maintainer.name',
      email: '$_builder.maintainer.email',
      updated: '$_builder.commit.time'
    }},
    {$group: {
      _id : '$email',
      updated: { $max: '$updated'},
      name : { $first: '$name'},
      login : { $addToSet: '$login'}, //login can be null
      orcids : { $addToSet: '$orcid'}, //orcid can be null or more than 1
      packages : { $addToSet: {
        package: '$package',
        user: '$user'
      }}
    }},
    {$project: {
      _id: 0,
      name: 1,
      login: { '$first' : '$login'},
      orcids: 1,
      email: '$_id',
      packages: '$packages',
      updated: 1
    }},
    {$sort:{ updated: -1}}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Double group: first by email, and then by login, such that
   if an email->login mapping changes, we use the most current
   github login associated with that maintainer email address.
   TODO: We convert array to object to array because I can't figure out a better way to get unique
   _user values, or better: aggregate so that we get counts per _user. */
router.get("/:user/stats/maintainers", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 100000;
  var query = {_user: req.params.user, _type: 'src', _registered : true};
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$sort:{ _published: -1}}, //assume most recent builds have most current email-login mapping
    {$group: {
      _id : '$_builder.maintainer.email',
      updated: { $max: '$_builder.commit.time'},
      name : { $first: '$_builder.maintainer.name'},
      login : { $addToSet: '$_builder.maintainer.login'}, //login can be null
      orcid : { $addToSet: '$_builder.maintainer.orcid'}, //login can be null
      orgs: { $push:  { "k": "$_user", "v": true}},
      count : { $sum: 1 }
    }},
    {$set: {orgs: {$arrayToObject: '$orgs'}, orcid: {$first: '$orcid'}, login: {$first: '$login'}}},
    {$group: {
      _id : { $ifNull: [ "$login", "$_id" ]},
      login: { $first: '$login'},
      emails: { $addToSet: '$_id' },
      updated: { $max: '$updated'},
      name : { $first: '$name'},
      orcid : { $addToSet: "$orcid"},
      count : { $sum: '$count'},
      orgs: {$mergeObjects: '$orgs'}
    }},
    {$project: {
      _id: 0,
      login: 1,
      emails: 1,
      updated: 1,
      name: 1,
      count : 1,
      orcid: {$first: '$orcid'},
      orgs: {$objectToArray: "$orgs"}
    }},
    {$set: {orgs: '$orgs.k'}},
    {$sort:{ updated: -1}},
    {$limit: limit}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/universes", function(req, res, next) {
  var query = {_user: req.params.user, _type: 'src', '_registered' : true};
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$project: {
      _id: 0,
      package: '$Package',
      user: '$_user',
      updated: '$_builder.commit.time',
      name: '$_builder.maintainer.name',
      email: '$_builder.maintainer.email',
      owner: '$_owner',
      organization: '$_builder.gitstats.organization'
    }},
    {$group: {
      _id : '$user',
      updated: { $max: '$updated'},
      maintainers: { $addToSet: '$email'},
      owners: { $addToSet: {
        owner: '$owner',
        organization: '$organization'
      }},
      packages : { $addToSet: '$package'},
    }},
    {$match: req.query.organization ? {$expr: {$in: [ {owner:'$_id', organization: true}, '$owners']}} : {}},
    {$project: {_id: 0, universe: '$_id', packages: 1, maintainers: 1, updated: 1, owners: 1}},
    {$sort:{ updated: -1}}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/contributions", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 100000;
  var cutoff = parseInt(req.query.cutoff) || 0;
  var user = req.params.user;
  var query = {_type: 'src', '_selfowned' : true};
  var contribfield = `_builder.gitstats.contributions.${user}`;
  query[contribfield] = { $gt: cutoff };
  if(req.query.skipself){
    query['_builder.maintainer.login'] = {$ne: user};
  }
  var cursor = packages.aggregate([
    {$match: query},
    {$group: {
      _id: "$_builder.upstream",
      owner: {$first: '$_user'}, //equals upstream org
      packages: {$addToSet: '$Package'},
      maintainers: {$addToSet: '$_builder.maintainer.login'}, //upstreams can have multiple pkgs and maintainers
      contributions: {$max: '$' + contribfield}
    }},
    {$project: {_id:0, contributions:'$contributions', upstream: '$_id', owner: '$owner', packages: '$packages', maintainers: '$maintainers'}},
    {$sort:{ contributions: -1}},
    {$limit: limit}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Group by upstream instead of package to avoid duplicate counting of contributions in
 * repos that have multiple packages, e.g. https://github.com/r-forge/ctm/tree/master/pkg
 */
router.get("/:user/stats/contributors", function(req, res, next) {
  /* TODO: small bug: $addToSet{upstream, count} can generate duplicates in case
     a package exists in multiple orgs but with different stats (e.g. an older rebuild) */
  var limit = parseInt(req.query.limit) || 100000;
  var query = {_user: req.params.user, _type: 'src', '_registered' : true};
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$project: {
      _id: 0,
      contributions: '$_builder.gitstats.contributions',
      upstream: '$_builder.upstream'
    }},
    {$addFields: {contributions: {$objectToArray:"$contributions"}}},
    {$unwind: "$contributions"},
    {$group: {_id: "$contributions.k", repos: {$addToSet: {upstream: '$upstream', count: '$contributions.v'}}}},
    {$project: {_id:0, login: '$_id', total: {$sum: '$repos.count'}, repos: 1}},
    {$sort:{ total: -1}},
    {$limit: limit}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/updates", function(req, res, next) {
  var query = {_user: req.params.user, _type: 'src', '_registered' : true};
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$project: {
      _id: 0,
      package: '$Package',
      updates: '$_builder.gitstats.updates'
    }},
    {$unwind: "$updates"},
    {$group: {_id: "$updates.week", total: {$sum: '$updates.n'}, packages: {$addToSet: {k:'$package', v:'$updates.n'}}}},
    {$project: {_id:0, week: '$_id', total: '$total', packages: {$arrayToObject: '$packages'}}},
    {$sort:{ week: 1}}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/pkgdeps", function(req,res,next){
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src', '_registered': true}, req.query.all)},
    {$set: {dependencies: '$_hard_deps'}},
    {$unwind: '$dependencies'},
    {$group: {
      _id : '$dependencies.package',
      revdeps : { $addToSet:
        {package: '$Package', role: '$dependencies.role'}
      }
    }},
    {$project: {_id: 0, package: '$_id', revdeps: '$revdeps'}},
    {$set: {total: { $size: "$revdeps" }}},
    {$sort:{total: -1}}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/pkgrevdeps", function(req,res,next){
  //group can be set to 'owner' or 'maintainer'
  var group = req.query.group || 'dependencies.package';
  var groupname = group.split('.').pop();
  var prequery = {_user: req.params.user, _type: 'src', '_selfowned' : true};
  packages.distinct('Package', qf(prequery, req.query.all)).then(function(pkgs){
    //var query = {_type: 'src', _selfowned : true, _hard_deps: {$elemMatch: { package: {$in: pkgs}}}};
    var query = {_type: 'src', _selfowned : true};
    var cursor = packages.aggregate([
      {$match: query},
      {$project: {_id: 0, owner: '$_user', package: '$Package', dependencies: '$_hard_deps', maintainer: '$_builder.maintainer.login'}},
      {$unwind: '$dependencies'},
      {$match: {'dependencies.package': {$in: pkgs}}},
      {$group: {
        _id : '$' + group,
        revdeps : { $addToSet:
          {package: '$package', uses: '$dependencies.package', owner: '$owner', maintainer:'$maintainer'}
        }
      }},
      {$project: {_id: 0, [groupname]: '$_id', revdeps: '$revdeps'}},
      {$set: {total: { $size: "$revdeps" }}},
      {$sort:{total: -1}}
    ]);
    return cursor.hasNext().then(function(){
      cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
    })
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/revdeps", function(req, res, next) {
  /* Filter by user after aggregate to get cross universe dependencies */
  var user = req.params.user;
  var soft_deps = req.query.soft ? '$_soft_deps' : [];
  var postmatch = {'revdeps.1': {$exists: true}};
  if(user != ":any"){
    postmatch['$or'] = [{'owner': user}, {'maintainer': user}];
  }
  var cursor = packages.aggregate([
    {$match: {_type: 'src', _selfowned : true}},
    {$project: {_id: 0, user: '$_user', package: '$Package', dependencies: {
      $concatArrays: ['$_hard_deps', soft_deps, [{
        package: '$Package',
        owner: '$_user',
        maintainer: '$_builder.maintainer.login',
        role: 'self'
      }]]}}
    },
    {$unwind: '$dependencies'},
    {$group: {
      _id : '$dependencies.package',
      revdeps : { $addToSet: 
        {user: '$user', package: '$package', maintainer:'$maintainer', role: '$dependencies.role'}
      }, //in theory the pkg can have multiple owners in case of a fork or name conflict
      owner: {$addToSet : '$dependencies.owner'},
      maintainer: {$addToSet : '$dependencies.maintainer'},
    }},
    {$match: postmatch},
    {$project: {_id: 0, owner: 1, maintainer:1, package: '$_id', revdeps: {
      $filter: {input: '$revdeps', as: 'dep', cond: {$ne: ["$$dep.role", 'self']}}}}},
    {$set: {count: { $size: "$revdeps" }}},
    {$sort:{count: -1}}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});


router.get("/:user/stats/sysdeps", function(req, res, next) {
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src', '_builder.sysdeps': {$exists: true}})},
    {$unwind: '$_builder.sysdeps'},
    {$group: {
      _id : '$_builder.sysdeps.name',
      packages: { $addToSet: '$_builder.sysdeps.package'},
      headers: { $addToSet: '$_builder.sysdeps.headers'},
      version: { $first: '$_builder.sysdeps.version'},
      distro : { $first: '$_builder.distro'},
      usedby : { $addToSet: {owner: '$_owner', package:'$Package'}}
    }},
    {$project: {_id: 0, library: '$_id', packages: 1, headers: 1, version: 1, usedby: 1, distro:1}},
    {$sort:{ library: 1}}
  ])
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/topics", function(req, res, next) {
  var min =  parseInt(req.query.min) || 1;
  var limit =  parseInt(req.query.limit) || 200;
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src'})},
    {$unwind: '$_builder.gitstats.topics'},
    {$group: {
      _id : '$_builder.gitstats.topics',
      packages: { $addToSet: '$Package' }
    }},
    {$project: {_id: 0, topic: '$_id', packages: '$packages', count: { $size: "$packages" }}},
    {$match:{count: {$gte: min}}},
    {$sort:{count: -1}},
    {$limit: limit}
  ])
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/files", function(req, res, next) {
  var query = qf({_user: req.params.user});
  if(req.query.type){
    query['_type'] = req.query.type;
  }
  if(req.query.before){
    query['_published'] = {'$lt': new Date(req.query.before)};
  }
  var projection = {
    _id: 0,
    type: '$_type',
    user: '$_user',
    package: '$Package',
    version: '$Version',
    r: '$Built.R',
    published: { $dateToString: { format: "%Y-%m-%d", date: "$_published" } }
  }
  if(req.query.fields){
    req.query.fields.split(",").forEach(function (f) {
      projection[f] = 1;
    });
  }
  var cursor = packages.find(query).project(projection);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

/* Operations below do not support :any user because they are very heavy */
router.get("/:user/stats/rundeps", function(req, res, next) {
  var cursor = packages.aggregate([
    {$match: {_user: req.params.user, _type: 'src'}},
    { $graphLookup: {
      from: "packages",
      startWith: "$_hard_deps.package",
      connectFromField: "_hard_deps.package",
      connectToField: "Package",
      as: "DependencyHierarchy"
    }},
    { $project: {Package: 1, rundeps: {'$setUnion': ['$DependencyHierarchy.Package']}}}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/checkdeps", function(req, res, next) {
  var cursor = packages.aggregate([
    {$match: {_user: req.params.user, _type: 'src'}},
    { $project: {_id: 0, Package: 1, deps: {$concatArrays: ['$_hard_deps', '$_soft_deps']}}},
    { $graphLookup: {
      from: "packages",
      startWith: "$deps.package",
      connectFromField: "_hard_deps.package",
      connectToField: "Package",
      as: "DependencyHierarchy"
    }},
    { $project: {Package: 1, checkdeps: {'$setUnion': ['$DependencyHierarchy.Package']}}}
  ]);
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});

router.get("/:user/stats/search", function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'src', _registered : true}, req.query.all);
  query['$text'] = { $search: req.query.q || "", $caseSensitive: false};
  var limit =  parseInt(req.query.limit) || 100;
  //todo: maybe combine textscore with popularity/activity?
  var cursor = packages.find(query, {limit:limit}).project({score:{$meta: "textScore"}}).sort({score:{$meta:"textScore"}});
  cursor.hasNext().then(function(){
    cursor.transformStream({transform: doc_to_ndjson}).pipe(res.type('text/plain'));
  }).catch(error_cb(400, next));
});


/* Simple 1 package case; see above for aggregates */
router.get('/:user/stats/usedby', function(req, res, next) {
  var package = req.query.package;
  var q0 = qf({_user: req.params.user, _type: 'src', _selfowned : true}, req.query.all);
  var q1 = Object.assign({}, q0, { '_hard_deps.package': package });
  var q2 = Object.assign({}, q0, { '_soft_deps.package': package });
  var p1 = packages.find(q1).project({_id: 0, owner: '$_owner', package: "$Package"}).toArray();
  var p2 = packages.find(q2).project({_id: 0, owner: '$_owner', package: "$Package"}).toArray();
  Promise.all([p1,p2]).then(data => res.send({hard: data[0], soft: data[1]})).catch(error_cb(400, next));
});

/* NB distinct() has memory limits, we may need to switch to aggregate everywhere */
router.get('/:user/stats/summary', function(req, res, next){
  var query = qf({_user: req.params.user, _type: 'src', _registered : true}, req.query.all);
  var p1 = packages.distinct('Package', query);
  var p2 = packages.distinct('_builder.maintainer.email', query);
  var p3 = packages.distinct('_builder.vignettes.title', query);
  var p4 = packages.aggregate([
    {$match:query},
    {$project: {contrib: {$objectToArray:"$_builder.gitstats.contributions"}}},
    {$unwind: "$contrib"},
    {$group: {_id: "$contrib.k"}},
    {$count: "total"}
  ]).next();
  Promise.all([p1, p2, p3, p4]).then((values) => {
    const out = doc_to_ndjson({
      packages: values[0].length,
      maintainers: values[1].length,
      articles: values[2].length,
      contributors: values[3].total
    });
    res.type('text/plain').send(out);
  });
});

module.exports = router;
