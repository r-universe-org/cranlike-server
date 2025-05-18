/* Packages */
import express from 'express';
import createError from 'http-errors';
import zlib from 'node:zlib';
import gunzip from 'gunzip-maybe';
import {qf, pkgfields, doc_to_dcf, group_package_data, match_macos_arch} from '../src/tools.js';
import {packages, bucket} from '../src/db.js';

const router = express.Router();

// Somehow node:stream/promises does not catch input on-error callbacks properly
// so we promisify ourselves. See https://github.com/r-universe-org/help/issues/540
function cursor_stream(cursor, output, transform, gzip){
  return new Promise(function(resolve, reject) {
    var input = cursor.stream({transform: transform}).on('error', reject);
    if(gzip){
      input = input.pipe(zlib.createGzip()).on('error', reject);
    }
    input.pipe(output).on('finish', resolve).on('error', reject);
  });
}

function send_results(cursor, res, stream = false, transform = (x) => x){
  //We only use hasNext() to catch broken queries and promisify response
  return cursor.hasNext().then(function(has_next){
    if(stream){
      return cursor_stream(cursor, res.type('text/plain'), doc => doc_to_ndjson(transform(doc)));
    } else {
      return cursor.toArray().then(function(out){
        return res.send(out.filter(x => x).map(transform));
      });
    }
  });
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

function array_size(key){
  return {$cond: [{ $isArray: key }, {$size: key}, 0 ]};
}

function array_first(key){
  return {$cond: [{ $isArray: key }, {$first: key}, null ]};
}

function stream_to_dcf(cursor, format, req, res){
  format = format && format.replace(/^\./, '');
  if(format == 'rds'){
    return res.status(404).send("PACKAGES.rds format not supported for now");
  }
  if(format && format !== 'gz' && format !== 'json'){
    throw createError(404, 'Unsupported PACKAGES format: ' + format);
  }

  let projection = {...pkgfields};
  if(req.query.fields){
    req.query.fields.split(",").forEach(function (f) {
      projection[f] = 1;
    });
  }

  // Get actual package data
  var cursor = cursor.project(projection).sort({"Package" : 1});
  if(!format){
    return cursor_stream(cursor, res.type('text/plain'), doc_to_dcf);
  } else if(format == 'gz'){
    return cursor_stream(cursor, res.type('application/x-gzip'), doc_to_dcf, true);
  } else if(format == 'json'){
    return cursor_stream(cursor, res.type('text/plain'), doc_to_ndjson);
  } else {
    cursor.close();
    throw createError(404, 'Unknown PACKAGES format: ' + format);
  }
}

function packages_index(query, format, req, res){
  return stream_to_dcf(packages.find(query), format, req, res);
}

function packages_index_aggregate(query, format, req, res){
  var cursor = packages.aggregate([
    {$match: query},
    {$sort: {_type: 1}},
    {$group : {
      _id : {'Package': '$Package'},
      doc: { '$first': '$$ROOT' }
    }},
    {$replaceRoot: { newRoot: '$doc' }}
  ]);
  return stream_to_dcf(cursor, req.params.ext, req, res);
}

function count_by_built(user, type){
  return packages.aggregate([
    {$match: {_user: user, _type : type}},
    {$group:{_id: {R: "$Built.R", Platform: "$Built.Platform"}, count: { $sum: 1 }}}
  ]).project({_id: 0, R: "$_id.R", Platform:"$_id.Platform", count: 1}).toArray();
}

//sort by type to get linux binary before src
function query_stream_info(query){
  var options = {project: {_fileid: 1, Redirect: 1}};
  if(query['$or']){
    options.sort = {_type: 1}; //prefer linux binary over src packages
  }
  return packages.findOne(query, options).then(function(docs){
    if(!docs)
      throw 'Package not found for query: ' + JSON.stringify(query);
    var hash = docs._fileid;
    return bucket.find({_id: hash}, {limit:1}).next().then(function(x){
      if (!x)
        throw `Failed to locate file in gridFS: ${hash}`;
      return x;
    });
  });
}

function send_binary(query, req, res, next, postfix){
  return query_stream_info(query).then(function(x){
    const hash = x['_id'];
    const host = req.headers.host || "";
    const cdn = host === 'localhost:3000' ? '/cdn' : 'https://cdn.r-universe.dev';
    res.redirect(`${cdn}/${hash}${postfix || ""}`);
  }).catch(function(err){
    // Workaround for race conditions: redirect to new version if just updated
    // This does not help if pak would use the DownloadURL from the PACKAGES file
    return packages.findOne({...query, _previous: query.Version, Version:{ $exists: true }}).then(function(doc){
      if(doc){
        res.redirect(req.path.replace(`_${query.Version}.`, `_${doc.Version}.`));
      } else {
        throw err;
      }
    }).catch(err => {throw createError(404, err)});
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

router.get('/:user/src', function(req, res, next) {
  res.redirect('/' + req.params.user + '/src/contrib');
});

router.get('/:user/bin', function(req, res, next) {
  return packages.aggregate([
    {$match: qf({_user: req.params.user})},
    {$group:{_id: "$_type", count: { $sum: 1 }}}
  ]).project({_id: 0, type: "$_id", count: 1}).toArray().then(function(x){
    res.send(x)
  });
});

router.get('/:user/bin/windows', function(req, res, next) {
  res.redirect('/' + req.params.user + '/bin/windows/contrib');
});

router.get('/:user/bin/macosx', function(req, res, next) {
  res.redirect('/' + req.params.user + '/bin/macosx/contrib');
});

/* CRAN-like index for source packages */
router.get('/:user/src/contrib/PACKAGES{:ext}', function(req, res, next) {
  return packages_index(qf({_user: req.params.user, _type: 'src'}), req.params.ext, req, res);
});

router.get('/:user/src/contrib/', function(req, res, next) {
  return packages_index(qf({_user: req.params.user, _type: 'src'}), 'json', req, res);
});

/* CRAN-like index for Windows packages */
router.get('/:user/bin/windows/contrib/:built/PACKAGES{:ext}', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}});
  return packages_index(query, req.params.ext, req, res);
});

router.get('/:user/bin/windows/contrib/:built/', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}});
  return packages_index(query, 'json', req, res);
});

/* CRAN-like index for MacOS packages */
router.get('/:user/bin/macosx/:xcode/contrib/:built/PACKAGES{:ext}', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}});
  query['Built.Platform'] = match_macos_arch(req.params.xcode || "legacy-x86_64");
  return packages_index(query, req.params.ext, req, res);
});

router.get('/:user/bin/macosx/:xcode/contrib/:built/', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}});
  query['Built.Platform'] = match_macos_arch(req.params.xcode || "legacy-x86_64");
  return packages_index(query, 'json', req, res);
});

/* CRAN-like index for Linux binaries (fake src pkg structure)
router.get('/:user/bin/linux/:distro/:built/src/contrib/PACKAGES\.:ext?', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'linux', '_distro': req.params.distro, 'Built.R' : {$regex: '^' + req.params.built}});
  packages_index(query, req.params.ext, req, res);
});

router.get('/:user/bin/linux/:distro/:built/src/contrib/', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'linux', '_distro': req.params.distro, 'Built.R' : {$regex: '^' + req.params.built}});
  packages_index(query, 'json', req, res);
});
*/

/* Linux binaries with fallback on source packages */
router.get('/:user/bin/linux/:distro/:built/src/contrib/PACKAGES{:ext}', function(req, res, next) {
  var query = {_user: req.params.user, '$or': [
    {_type: 'src'},
    {_type: 'linux', '_distro': req.params.distro, 'Built.R' : {$regex: '^' + req.params.built}},
  ]};
  return packages_index_aggregate(query, req.params.ext, req, res);
});

router.get('/:user/bin/linux/:distro/:built/src/contrib/', function(req, res, next) {
  var query = {_user: req.params.user, '$or': [
    {_type: 'src'},
    {_type: 'linux', '_distro': req.params.distro, 'Built.R' : {$regex: '^' + req.params.built}},
  ]};
  return packages_index_aggregate(query, 'json', req, res);
});

router.get('/:user/bin/linux/:distro/:built', function(req, res, next) {
  res.redirect(req.path + '/src/contrib');
});

/* CRAN-like index for WASM packages */
router.get('/:user/bin/emscripten/contrib/:built/PACKAGES{:ext}', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'wasm', 'Built.R' : {$regex: '^' + req.params.built}});
  return packages_index(query, req.params.ext, req, res);
});

router.get('/:user/bin/emscripten/contrib/:built/', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'wasm', 'Built.R' : {$regex: '^' + req.params.built}});
  return packages_index(query, 'json', req, res);
});

/* Index available R builds for binary pkgs */
router.get('/:user/bin/windows/contrib', function(req, res, next) {
  return count_by_built(req.params.user, 'win').then(out => res.send(out));
});

router.get('/:user/bin/macosx/:xcode/contrib', function(req, res, next) {
  return count_by_built(req.params.user, 'mac').then(out => res.send(out));
});

router.get('/:user/bin/emscripten/contrib', function(req, res, next) {
  return count_by_built(req.params.user, 'wasm').then(out => res.send(out));
});

/* Download package files */
router.get('/:user/src/contrib/:pkg.tar.gz', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'src', Package: pkg, Version: version});
  return send_binary(query, req, res, next);
});

router.get('/:user/bin/windows/contrib/:built/:pkg.zip', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg, Version: version});
  return send_binary(query, req, res, next);
});

router.get('/:user/bin/macosx/:xcode/contrib/:built/:pkg.tgz', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg, Version: version});
  query['Built.Platform'] = match_macos_arch(req.params.xcode || "legacy-x86_64");
  return send_binary(query, req, res, next);
});

/*
router.get('/:user/bin/linux/:distro/:built/src/contrib/:pkg.tar.gz', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'linux', 'Built.R' : {$regex: '^' + req.params.built},
    '_distro' : req.params.distro, Package: pkg, Version: version});
  send_binary(query, req, res, next);
});
*/

router.get('/:user/bin/linux/:distro/:built/src/contrib/:pkg.tar.gz', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = {_user: req.params.user, Package: pkg, Version: version, '$or': [
    {_type: 'src'},
    {_type: 'linux', '_distro': req.params.distro, 'Built.R' : {$regex: '^' + req.params.built}},
  ]};
  return send_binary(query, req, res, next);
});

router.get('/:user/bin/emscripten/contrib/:built/:pkg.tgz', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'wasm', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg, Version: version});
  return send_binary(query, req, res, next);
});

router.get('/:user/bin/emscripten/contrib/:built/:pkg.data.gz', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'wasm', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg, Version: version});
  return send_binary(query, req, res, next);
});

router.get('/:user/bin/emscripten/contrib/:built/:pkg.data', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'wasm', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg, Version: version});
  return send_binary(query, req, res, next, `/decompress`);
});

router.get('/:user/bin/emscripten/contrib/:built/:pkg.js.metadata', function(req, res, next) {
  var [pkg, version] = req.params.pkg.split("_");
  var query = qf({_user: req.params.user, _type: 'wasm', 'Built.R' : {$regex: '^' + req.params.built},
    Package: pkg, Version: version});
  return send_binary(query, req, res, next, `/index`);
});

router.get('/:user/api', function(req, res, next) {
  res.redirect(301, `/${req.params.user}/api/ls`);
});

//Formerly /:user/packages but this is now a UI endpoint
router.get('/:user/api/ls', function(req, res, next) {
  return packages.distinct('Package', {_user : req.params.user}).then(function(x){
    res.send(x);
  });
});

router.get('/:user/api/packages{/:package}', function(req, res, next) {
  var user = req.params.user;
  var pkgname = req.params.package;
  var projection = {_id:0};
  if(req.query.fields){
    var projection = {Package:1, _type:1, _user:1, _indexed: 1, _id:0};
    var fields = req.query.fields.split(",");
    fields.forEach(function (f) {
      if(f == '_binaries'){
        projection['Built'] = 1;
        projection['_status'] = 1;
        projection['_check'] = 1;
        if(!fields.includes("_commit"))
          projection['_commit.id'] = 1;
      } else {
        projection[f] = 1;
      }
    });
  }

  /* return data for a given package only */
  if(pkgname){
    return packages.find({_user : user, Package : pkgname}).project(projection).toArray().then(function(docs){
      if(!docs.length)
        throw createError(404, `No package '${pkgname}' found in https://${user}.r-universe.dev`);
      res.send(group_package_data(docs));
    });
  }

  /* Only src pkg has _indexed field, so first group and then filter again by _indexed
     otherwise we don't get the binaries for non-indexed packages */
  var query = req.query.all ? {'_universes': user} : {'_user': user};
  if(user == ":any" || user == 'cran'){
    query['_commit.time'] = {'$gt': days_ago(parseInt(req.query.days) || 7)};
  }
  var limit = parseInt(req.query.limit) || 2500;
  var cursor = packages.aggregate([
    {$match: query},
    {$project: projection},
    {$group : {
      _id : {'Package': '$Package', 'user':'$_user'},
      indexed: { $addToSet: "$_indexed" },
      timestamp: { $max : "$_commit.time" },
      files: { '$push': '$$ROOT' }
    }},
    {$match: {'$or' : [{indexed: true}, {'_id.user': user}]}},
    {$sort : {timestamp : -1}},
    {$limit : limit}
  ]);
  return send_results(cursor, res, req.query.stream, (x) => group_package_data(x.files));
});

router.get("/:user/api/universes", function(req, res, next) {
  var query = {_type: 'src', _registered: true};
  var limit = parseInt(req.query.limit) || 100000;
  if(req.query.type){
    query['_userbio.type'] = req.query.type;
  }
  if(req.query.skipcran){
    query['_user'] = {$ne: 'cran'};
  }
  var cursor = packages.aggregate([
    {$match: query},
    {$sort:{ _id: -1}},
    {$group: {
      _id : '$_user',
      updated: { $max: '$_commit.time'},
      packages: { $sum: 1 },
      indexed: { $sum: { $toInt: '$_indexed' }},
      name: { $first: '$_userbio.name'},
      type: { $first: '$_userbio.type'},
      uuid: { $first: '$_userbio.uuid'},
      bio: { $first: '$_userbio.description'},
      emails: { $addToSet: '$_maintainer.email'}
    }},
    {$project: {_id: 0, universe: '$_id', packages: 1, updated: 1, type: 1, uuid: 1,
      indexed:1, name: 1, type: 1, bio: 1, maintainers: { $size: '$emails' },
    }},
    {$sort:{ indexed: -1}},
    {$limit : limit},
  ]);
  return send_results(cursor, res, req.query.stream)
});

router.get("/:user/api/scores", function(req, res, next) {
  var query = {_type: 'src', _indexed: true};
  var projection = {
    _id: 0,
    package: '$Package',
    universe: "$_user",
    score: '$_score',
    stars: "$_stars",
    downloads: "$_downloads.count",
    scripts: "$_searchresults",
    dependents: '$_usedby',
    commits: {$sum: '$_updates.n'},
    contributors: array_size('$_contributors'),
    datasets: array_size('$_datasets'),
    vignettes: array_size('$_vignettes'),
    releases: array_size('$_releases')
  }
  var cursor = packages.find(query).sort({_score: -1}).project(projection);
  return send_results(cursor, res, req.query.stream)
});

router.get("/:user/api/articles", function(req, res, next) {
  var cursor = packages.aggregate([
    {$match: {_type: 'src', _indexed: true, '_vignettes' : {$exists: true}}},
    {$project: {
      _id: 0,
      universe: '$_user',
      package: '$Package',
      maintainer: '$_maintainer.name',
      vignette: '$_vignettes'
    }},
    {$unwind: '$vignette'},
    {$project: {
      _id: 0,
      universe: 1,
      package: 1,
      title: '$vignette.title',
      filename: '$vignette.filename',
      author: { $ifNull: [ '$vignette.author', '$maintainer' ]},
      updated: '$vignette.modified'
    }},
    {$sort:{ updated: -1}},
  ]);
  return send_results(cursor, res, req.query.stream);
});

router.get("/:user/api/datasets", function(req, res, next) {
  var cursor = packages.aggregate([
    {$match: {_type: 'src', _indexed: true, '_datasets' : {$exists: true}}},
    {$sort:{ _id: -1}},
    {$project: {
      _id: 0,
      universe: '$_user',
      package: '$Package',
      dataset: '$_datasets'
    }},
    {$unwind: '$dataset'},
    {$project: {
      _id: 0,
      universe: 1,
      package: 1,
      name: '$dataset.name',
      title: '$dataset.title',
      class: array_first('$dataset.class'),
      rows: '$dataset.rows',
      fields: array_size('$dataset.fields')
    }}
  ]);
  return send_results(cursor, res, req.query.stream);
});

router.get("/:user/api/dbdump", function(req, res, next) {
  var query = {};
  if(req.params.user != ":any"){
    query._user = req.params.user;
  }
  if(!req.query.everything){
    query._type = 'src'
  }
  var cursor = packages.find(query, {raw: true});
  return cursor_stream(cursor, res.type("application/bson"));
});

router.get("/:user/stats/vignettes", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 200;
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src', '_vignettes' : {$exists: true}}, req.query.all)},
    {$sort : {'_commit.time' : -1}},
    {$limit : limit},
    {$project: {
      _id: 0,
      user: '$_user',
      package: '$Package',
      version: '$Version',
      maintainer: '$Maintainer',
      universe: '$_user',
      pkglogo: '$_pkglogo',
      upstream: '$_upstream',
      login: '$_maintainer.login',
      published: '$_commit.time',
      vignette: '$_vignettes'
    }},
    {$unwind: '$vignette'}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/datasets", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 500;
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src', '_datasets' : {$exists: true}}, req.query.all)},
    {$sort : {'_commit.time' : -1}},
    {$limit : limit},
    {$project: {
      _id: 0,
      user: '$_user',
      package: '$Package',
      version: '$Version',
      maintainer: '$Maintainer',
      universe: '$_user',
      pkglogo: '$_pkglogo',
      upstream: '$_upstream',
      login: '$_maintainer.login',
      published: '$_commit.time',
      dataset: '$_datasets'
    }},
    {$unwind: '$dataset'}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});


/* Public aggregated data (these support :any users)*/
router.get('/:user/stats/descriptions', function(req, res, next) {
  var user = req.params.user;
  var limit = parseInt(req.query.limit) || 500;
  var query = qf({_user: user, _type: 'src', _registered : true}, req.query.all);
  if(user == ":any" || user == 'cran'){
    query['_commit.time'] = {'$gt': days_ago(parseInt(req.query.days) || 7)};
  }
  var cursor = packages.find(query, {limit:limit}).sort({"_commit.time" : -1}).project({_id:0, _type:0});
  return send_results(cursor, res.type('text/plain'), true);
});

/* Failures(these support :any users)*/
router.get('/:user/stats/failures', function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'failure'}, req.query.all);
  var cursor = packages.find(query).sort({"_id" : -1}).project({_id:0, _type:0});
  return send_results(cursor, res.type('text/plain'), true);
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
      timestamp: { $max : "$_commit.time" },
      registered: { $first: "$_registered" },
      os_restriction: { $addToSet: '$OS_type'},
      runs : { $addToSet: { type: "$_type", built: '$Built', date:'$_published'}}
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
  return send_results(cursor, res.type('text/plain'), true);
});

function days_ago(n){
  var now = new Date();
  return now.getTime()/1000 - (n*60*60*24);
}

router.get('/:user/stats/builds', function(req, res, next) {
  var user = req.params.user;
  var query = qf({_user: user}, req.query.all);
  var limit = parseInt(req.query.limit) || 500;
  if(user == ":any" || user == 'cran'){
    query['_commit.time'] = {'$gt': days_ago(parseInt(req.query.days) || 7)};
  }
  var cursor = packages.aggregate([
    {$match: query},
    {$group : {
      _id : { user: '$_user', package: '$Package', commit: '$_commit.id'},
      version: { $first : "$Version" },
      maintainer: { $first : "$_maintainer.name" },
      maintainerlogin: { $first : "$_maintainer.login" },
      timestamp: { $first : "$_commit.time" },
      upstream: { $first : "$_upstream" },
      registered: { $first: "$_registered" },
      os_restriction: { $addToSet: '$OS_type'},
      sysdeps: { $addToSet: '$_sysdeps'},
      pkgdocs: { $addToSet : '$_pkgdocs' },
      macbinary: { $addToSet : '$_macbinary' },
      winbinary: { $addToSet : '$_winbinary' },
      runs : { $addToSet:
        { type: "$_type", built: '$Built', date:'$_published', url: '$_buildurl', status: '$_status', distro: '$_distro', check: '$_check'}
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
      macbinary: { $first: "$macbinary" },
      winbinary: { $first: "$winbinary" },
      os_restriction:{ $first: "$os_restriction" }
    }},
    {$limit: limit}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
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
      login: '$_maintainer.login',
      orcid: '$_maintainer.orcid',
      name: '$_maintainer.name',
      email: '$_maintainer.email',
      updated: '$_commit.time'
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
  return send_results(cursor, res.type('text/plain'), true);
});

/* Double group: first by email, and then by login, such that
   if an email->login mapping changes, we use the most current
   github login associated with that maintainer email address.
   TODO: We convert array to object to array because I can't figure out a better way to get unique
   _user values, or better: aggregate so that we get counts per _user. */
router.get("/:user/stats/maintainers", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 100;
  var query = {_user: req.params.user, _type: 'src', _registered : true};
   //We assume $natural sort such that the last matches have most recent email-login mapping.
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$group: {
      _id : '$_maintainer.email',
      updated: { $max: '$_commit.time'},
      name : { $first: '$_maintainer.name'},
      uuid : { $addToSet: '$_maintainer.uuid'}, //can be null
      login : { $addToSet: '$_maintainer.login'}, //can be null
      orcid : { $addToSet: '$_maintainer.orcid'}, //can be null
      mastodon : { $addToSet: '$_maintainer.mastodon'}, //can be null
      bluesky : { $addToSet: '$_maintainer.bluesky'}, //can be null
      linkedin : { $addToSet: '$_maintainer.linkedin'}, //can be null
      orgs: { $push:  { "k": "$_user", "v": true}},
      count : { $sum: 1 }
    }},
    {$set: {orgs: {$arrayToObject: '$orgs'}, orcid: {$last: '$orcid'}, mastodon: {$last: '$mastodon'}, bluesky: {$last: '$bluesky'}, linkedin: {$last: '$linkedin'}, uuid: {$last: '$uuid'}, login: {$last: '$login'}}},
    {$group: {
      _id : { $ifNull: [ "$login", "$_id" ]},
      uuid: { $last: '$uuid'},
      login: { $last: '$login'},
      emails: { $addToSet: '$_id' },
      updated: { $max: '$updated'},
      name : { $last: '$name'},
      orcid : { $addToSet: "$orcid"},
      bluesky : { $addToSet: "$bluesky"},
      linkedin : { $addToSet: "$linkedin"},
      mastodon : { $addToSet: "$mastodon"},
      count : { $sum: '$count'},
      orgs: {$mergeObjects: '$orgs'}
    }},
    {$project: {
      _id: 0,
      login: 1,
      uuid: 1,
      emails: 1,
      updated: 1,
      name: 1,
      count : 1,
      orcid: {$last: '$orcid'},
      bluesky: {$last: '$bluesky'},
      linkedin: {$last: '$linkedin'},
      mastodon: {$last: '$mastodon'},
      orgs: {$objectToArray: "$orgs"}
    }},
    {$set: {orgs: '$orgs.k'}},
    {$sort:{ count: -1}},
    {$limit: limit}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/universes", function(req, res, next) {
  var query = {_user: req.params.user, _type: {$in: ['src', 'failure']}, '_registered' : true};
  if(req.query.organization){
    query['_userbio.type'] = 'organization';
  }
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$project: {
      _id: 0,
      package: '$Package',
      user: '$_user',
      updated: '$_commit.time',
      name: '$_maintainer.name',
      email: '$_maintainer.email'
    }},
    {$group: {
      _id : '$user',
      updated: { $max: '$updated'},
      maintainers: { $addToSet: '$email'},
      packages : { $addToSet: '$package'},
    }},
    {$project: {_id: 0, universe: '$_id', packages: 1, maintainers: 1, updated: 1}},
    {$sort:{ updated: -1}}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/contributions", function(req, res, next) {
  var limit = parseInt(req.query.limit) || 100000;
  var user = req.params.user;
  var query = {_type: 'src', '_contributors.user': user, '_indexed' : true};
  if(req.query.skipself){
    query['_maintainer.login'] = {$ne: user};
  }
  var cursor = packages.aggregate([
    {$match: query},
    {$addFields: {contrib: {$arrayElemAt:['$_contributors', { $indexOfArray: [ "$_contributors.user", user ]}]}}},
    {$group: {
      _id: "$_upstream",
      owner: {$first: '$_user'}, //equals upstream org
      packages: {$addToSet: '$Package'},
      maintainers: {$addToSet: '$_maintainer.login'}, //upstreams can have multiple pkgs and maintainers
      contributions: {$max: '$contrib.count'}
    }},
    {$project: {_id:0, contributions:'$contributions', upstream: '$_id', owner: '$owner', packages: '$packages', maintainers: '$maintainers'}},
    {$sort:{ contributions: -1}},
    {$limit: limit}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
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
      contributors: '$_contributors',
      upstream: '$_upstream'
    }},
    {$unwind: "$contributors"},
    {$group: {_id: "$contributors.user", repos: {$addToSet: {upstream: '$upstream', count: '$contributors.count'}}}},
    {$project: {_id:0, login: '$_id', total: {$sum: '$repos.count'}, repos: 1}},
    {$sort:{ total: -1}},
    {$limit: limit}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});


router.get("/:user/stats/updates", function(req, res, next) {
  var query = {_user: req.params.user, _type: 'src', '_registered' : true};
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$project: {
      _id: 0,
      package: '$Package',
      updates: '$_updates'
    }},
    {$unwind: "$updates"},
    {$group: {_id: "$updates.week", total: {$sum: '$updates.n'}, packages: {$addToSet: {k:'$package', v:'$updates.n'}}}},
    {$project: {_id:0, week: '$_id', total: '$total', packages: {$arrayToObject:{$sortArray: { input: "$packages", sortBy: { v: -1 } }}}}},
    {$sort:{ week: 1}}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/pkgdeps", function(req,res,next){
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src', '_registered': true}, req.query.all)},
    {$set: {dependencies: '$_dependencies'}},
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
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/pkgrevdeps", function(req,res,next){
  //group can be set to 'owner' or 'maintainer'
  var group = req.query.group || 'dependencies.package';
  var groupname = group.split('.').pop();
  var prequery = {_user: req.params.user, _type: 'src', '_indexed' : true};
  return packages.distinct('Package', qf(prequery, req.query.all)).then(function(pkgs){
    var query = {_type: 'src', _indexed : true};
    var cursor = packages.aggregate([
      {$match: query},
      {$project: {_id: 0, owner: '$_user', package: '$Package', dependencies: '$_dependencies', maintainer: '$_maintainer.login'}},
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
    return send_results(cursor, res.type('text/plain'), true);
  });
});

router.get("/:user/stats/revdeps", function(req, res, next) {
  /* Filter by user after aggregate to get cross universe dependencies */
  var user = req.params.user;
  var postmatch = {'revdeps.1': {$exists: true}};
  if(user != ":any"){
    postmatch['$or'] = [{'owner': user}, {'maintainer': user}];
  }
  var cursor = packages.aggregate([
    {$match: {_type: 'src', _indexed : true}},
    {$project: {_id: 0, user: '$_user', package: '$Package', dependencies: {
      $concatArrays: ['$_dependencies', soft_deps, [{
        package: '$Package',
        owner: '$_user',
        maintainer: '$_maintainer.login',
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
  return send_results(cursor, res.type('text/plain'), true);
});


router.get("/:user/stats/sysdeps{/:distro}", function(req, res, next) {
  var query = {_user: req.params.user, _type: 'src', '_sysdeps': {$exists: true}};
  if(req.params.distro){
    query['_distro'] = req.params.distro;
  }
  var cursor = packages.aggregate([
    {$match: qf(query, req.query.all)},
    {$unwind: '$_sysdeps'},
    {$group: {
      _id : '$_sysdeps.name',
      packages: { $addToSet: '$_sysdeps.package'},
      headers: { $addToSet: '$_sysdeps.headers'},
      version: { $first: '$_sysdeps.version'},
      homepage: { $addToSet: '$_sysdeps.homepage'},
      description: { $addToSet: '$_sysdeps.description'},
      distro : { $addToSet: '$_distro'},
      usedby : { $addToSet: {owner: '$_owner', package:'$Package'}}
    }},
    {$project: {_id: 0, library: '$_id', packages: 1, headers: 1, version: 1, usedby: 1,
      homepage: { '$first' : '$homepage'}, description: { '$first' : '$description'}, distro:{ '$first' : '$distro'}}},
    {$sort:{ library: 1}}
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/topics", function(req, res, next) {
  var min =  parseInt(req.query.min) || 1;
  var limit =  parseInt(req.query.limit) || 200;
  var cursor = packages.aggregate([
    {$match: qf({_user: req.params.user, _type: 'src'})},
    {$unwind: '$_topics'},
    {$group: {
      _id : '$_topics',
      packages: { $addToSet: '$Package' }
    }},
    {$project: {_id: 0, topic: '$_id', packages: '$packages', count: { $size: "$packages" }}},
    {$match:{count: {$gte: min}}},
    {$sort:{count: -1}},
    {$limit: limit}
  ])
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/files", function(req, res, next) {
  var query = qf({_user: req.params.user});
  if(req.query.type){
    query['_type'] = req.query.type;
  }
  if(req.query.before){
    query['_created'] = {'$lt': new Date(req.query.before)};
  }
  var projection = {
    _id: 0,
    type: '$_type',
    user: '$_user',
    package: '$Package',
    version: '$Version',
    r: '$Built.R',
    published: { $dateToString: { format: "%Y-%m-%d", date: "$_created" } }
  }
  if(req.query.fields){
    req.query.fields.split(",").forEach(function (f) {
      projection[f] = 1;
    });
  }
  var cursor = packages.find(query).project(projection);
  return send_results(cursor, res.type('text/plain'), true);
});

router.get("/:user/stats/search", function(req, res, next) {
  var query = qf({_user: req.params.user, _type: 'src', _registered : true}, req.query.all);
  query['$text'] = { $search: req.query.q || "", $caseSensitive: false};
  var limit =  parseInt(req.query.limit) || 100;
  var cursor = packages.find(query, {limit:limit}).project({match:{$meta: "textScore"}}).sort({match:{$meta:"textScore"}});
  return send_results(cursor, res.type('text/plain'), true);
});

/* Simple 1 package revdep cases; see above for aggregates */
router.get('/:user/stats/usedby', function(req, res, next) {
  var pkgname = req.query.package;
  var query = qf({_user: req.params.user, _type: 'src', '_dependencies.package': pkgname, '_indexed': true}, req.query.all);
  var cursor = packages.find(query).project({_id: 0, owner: '$_owner', package: "$Package"}).sort({'_stars': -1});
  return send_results(cursor, res.type('text/plain'), true);
});

router.get('/:user/stats/usedbyorg', function(req, res, next) {
  var user = req.params.user;
  var pkgname = req.query.package;
  var query = qf({_user: user, _type: 'src', '_dependencies.package': pkgname, '_indexed': true}, req.query.all);
  var cursor = packages.aggregate([
    {$match:query},
    {$group : {
      _id: "$_user",
      packages : { $addToSet: { package: "$Package", maintainer :'$_maintainer.login', stars: '$_stars'}},
      allstars: { $sum: '$_stars'},
    }},
    {$project:{_id: 0, owner: "$_id", packages: 1, allstars:1}},
    {$sort : {allstars : -1}},
  ]);
  return send_results(cursor, res.type('text/plain'), true);
});

function summary_count(k, q) {
  return packages.aggregate([
    {$match:q},
    {$unwind: `$${k.split('.')[0]}`},
    {$count: "total"}
  ]);
}

function summary_unique(k, q) {
  return packages.aggregate([
    {$match:q},
    {$unwind: `$${k.split('.')[0]}`},
    {$group: {_id: { $toHashedIndexKey: `$${k}`}}},
    {$count: "total"}
  ]);
}

function summary_object(k, q) {
  return packages.aggregate([
    {$match:q},
    {$project: {x: {$objectToArray:`$${k}`}}},
    {$unwind: "$x"},
    {$group: {_id: "$x.k"}},
    {$count: "total"}
  ]);
}

router.get('/:user/stats/summary', function(req, res, next){
  var query = {_type: 'src'}; // this api is very, only use indexed fields
  if(req.params.user != ":any"){
    query._user = req.params.user;
  }
  var p1 = summary_unique('Package', query);
  var p2 = summary_unique('_maintainer.email', query);
  var p3 = summary_count('_vignettes.source', query);
  var p4 = summary_count('_datasets.name', query);
  var p5 = summary_unique('_user', {'_userbio.type': 'organization', ...query});
  var p6 = summary_unique('_contributors.user', query);
  var promises = [p1, p2, p3, p4, p5, p6].map(function(p){
    return p.next().then(res => res ? res.total : 0);
  })
  return Promise.all(promises).then(function(values){
    const out = {
      packages: values[0],
      maintainers: values[1],
      articles: values[2],
      datasets: values[3],
      organizations: values[4],
      contributors: values[5]
    };
    res.send(out);
  });
});

router.get('/:user/stats/everyone', function(req, res, next){
  var query = qf({_user: req.params.user, _type: {$in: ['src', 'failure']}, _registered : true}, req.query.all);
  var p1 = packages.distinct('_user', query);
  var p2 = packages.distinct('_maintainer.login', query);
  return Promise.all([p1, p2]).then((values) => {
    const out = {
      universes: values[0].sort(),
      maintainers: values[1].sort()
    };
    res.send(out);
  });
});

router.get('/:user/stats/percentiles', function(req, res, next){
  var length = Math.min(parseInt(req.query.length) || 10, 100);
  var fields = req.query.fields ? req.query.fields.split(",") : ['_score', '_downloads.count', '_stars'];
  var percentiles = Array.from({ length: length + 1 }, (value, index) => index/length)
  console.log(percentiles)
  var groups = {_id: null};
  fields.forEach(function(x){
    groups[x] = {$percentile : {input: `$${x}`, method: 'approximate', p: percentiles}}
  });
  var cursor = packages.aggregate([
    {$match: { _type: "src", _indexed: true}},
    {$group: groups}
  ]);
  return cursor.next().then(function(x){
    var out = percentiles.map(function(pct, i){
      var val = {percentile: pct};
      fields.forEach(function(f){
        val[f] = x[f][i];
      });
      return val;
    });
    res.send(out);
  });
});

/* Legacy redirects */
router.get('/:user/docs/:pkg/NEWS{:ext}', function(req, res, next){
  res.redirect(301, `/${req.params.user}/${req.params.pkg}/NEWS${req.params.ext || ""}`);
});

router.get('/:user/docs/:pkg/DESCRIPTION', function(req, res, next){
  res.redirect(301, `/${req.params.user}/${req.params.pkg}/DESCRIPTION`);
});

router.get('/:user/docs/:pkg/doc{/:file}', function(req, res, next){
 res.redirect(301, `/${req.params.user}/${req.params.pkg}/doc/${req.params.file || ""}`);
});

router.get('/:user/citation/:pkg.:type', function(req, res, next){
  res.redirect(301, `/${req.params.user}/${req.params.pkg}/citation.${req.params.type || ""}`);
});

router.get('/:user/manual/:pkg.pdf', function(req, res, next){
  res.redirect(301, `/${req.params.user}/${req.params.pkg}/${req.params.pkg}.pdf`);
});

router.get('/:user/manual/:pkg.html', function(req, res, next){
  res.redirect(301, `/${req.params.user}/${req.params.pkg}/doc/manual.html`);
});

router.get('/:user/readme/:pkg.html', function(req, res, next){
  res.redirect(301, `/${req.params.user}/${req.params.pkg}/doc/readme.html`);
});

export default router;
