const express = require('express');
const createError = require('http-errors');
const webr = require("@r-universe/webr");
const router = express.Router();
const tools = require("../src/tools.js");

function new_rsession(preload){
  var session;

  function start(){
    session = new webr.WebR();
    session.started = new Date();
    session.reset = reset;
    session.preloaded = preload;
    return session.init().then(function(){
      return session.evalRVoid(`getNamespace("${preload}")`)
    }).then(function(){
      console.log(`webR with preloaded ${preload} is ready!`);
    }).catch(function(e){
      console.log("ERROR: problem initiating webr! " + e);
    });
  }

  function reset(if_older_than){
    const now = new Date();
    const age = now - session.started;
    if(age < if_older_than)
      return;
    var oldsession = session;
    start().then(function(){
      var timer = setTimeout(function(){
        console.log("Timeout: closing hung R session");
        oldsession.close();
      }, 60*1000);
      oldsession.evalRVoid(`1+1`).finally(function(){
        clearTimeout(timer);
        console.log('Closing old R session');
        oldsession.close();
      });
    });
  }

  start();
  return {
    get: function(){
      return session;
    }
  }
}

function new_pool(){
  var pkgmap = {
    'rds' : 'base',
    'rda' : 'base',
    'json': 'jsonlite',
    'ndjson': 'jsonlite',
    'csv': 'data.table',
    'csv.gz' : 'data.table',
    'xlsx': 'writexl'
  }

  var workers = {};
  Object.values(pkgmap).forEach(pkg => {
    workers[pkg] = workers[pkg] || new_rsession(pkg);
  });

  return function(format){
    var pkg = pkgmap[format] || 'base';
    return workers[pkg].get();
  }
}

var get_session = new new_pool();

router.get('/:user/:package/data/:name?/:format?', function(req, res, next){
  var user =  req.params.user;
  var package = req.params.package;
  var name = req.params.name;
  var format = req.params.format;
  var query = {'_user': user, 'Package': package, '_type': 'src'};
  var key = `${package}_${name}`.replace(/\W+/g, "");
  var session = get_session(format);
  console.log(`Selected R session with ${session.preloaded}`)
  var supported = ['csv', 'csv.gz', 'xlsx', 'json', 'ndjson', 'rda', 'rds'];
  return packages.findOne(query).then(async function(x){
    var lazydata = ['yes', 'true'].includes((x['LazyData'] || "").toLowerCase());
    var datasets = x['_contents'] && x['_contents'].datasets || [];
    if(!name) {
      return res.send(datasets);
    } else {
      if(!format){
        return res.redirect(req.path.replace(/\/$/, '') + '/csv');
      }
      if(!supported.includes(format)){
        throw `Unsupported format: ${format}`;
      }
      var ds = datasets.find(x => x.name == name);
      if(!ds)
        throw `No data "${name}" found in ${package}`;
      query['_type'] = {'$in' : ['mac', 'linux']};
      if(lazydata){
        var files = [`Rdata.rdb`, `Rdata.rdx`];
      } else if(ds.file) {
        var files = [ ds.file ];
      } else {
        throw "Unable to extract this data";
      }
      var buffers = await tools.get_extracted_file(query, files.map(x => `${package}/data/${x}`));
      for (var i = 0; i < files.length; i++) {
        if(!buffers[i] || !buffers[i].length)
          throw `Failed to extract ${files[i]}`;
        var ext = files[i].match(/\..*$/)[0];
        var inputfile = `${key}${ext}`;
        await session.FS.writeFile(`${inputfile}`, (new Uint8Array(buffers[i])));
      }
      await session.evalRVoid(`datatool::convert("${inputfile}", "${name}", "${format}", "${key}.out")`,
        {captureStreams: false});
      var outbuf = await session.FS.readFile(`${key}.out`);
      switch(format) {
        case 'csv':
        case 'csv.gz':
        case 'rds':
          res.attachment(`${name}.${format}`);
          break;
        case 'rda':
          res.attachment(`${name}.RData`);
          break;
        case 'xlsx':
          res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(`${name}.xlsx`);
          break;
        case 'json':
          res.type('application/json');
          break;
        case 'ndjson':
          res.type("text/plain");
          break;
        default:
          throw "Only csv, json, xlsx, rda format is supported";
      }
      return res.send(Buffer.from(outbuf, 'binary'));
    }
  }).catch(function(err){
    next(createError(400, err));
    if(err.stack){
      console.log("Got an R error. Restarting R...", err.stack);
      session.reset(60*1000); //restart R after error (but at most once per minute)
    }
  }).finally(function(){
    session.evalRVoid(`unlink('${key}.*')`);
    session.reset(3600*1000); //restart R sessions once per hour
  });
});

module.exports = router;
