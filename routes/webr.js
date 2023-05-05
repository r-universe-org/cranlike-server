const express = require('express');
const createError = require('http-errors');
const webr = require("@r-universe/webr");
const router = express.Router();
const tools = require("../src/tools.js");

/* Start or restart webr */
var session;
function reset_webr(if_older_than = 0){
  const now = new Date();
  if(session && (now - session.started < if_older_than)){
    return;
  }
  const oldsession = session;
  session = new webr.WebR();
  session.started = new Date();
  session.init().then(function(){
    console.log("webR is ready!");
  }).catch(function(e){
    console.log("ERROR: problem starting webr! " + e);
  });
  if(oldsession){
    var timer = setTimeout(function(){
      console.log("Timeout: closing hung R session");
      oldsession.close();
    }, 60*1000);
    oldsession.evalRVoid(`1+1`).finally(function(){
      clearTimeout(timer);
      console.log('Closing old R session');
      oldsession.close();
    });
  }
}

reset_webr();

router.get('/:user/:package/data/:name?/:format?', function(req, res, next){
  var user =  req.params.user;
  var package = req.params.package;
  var name = req.params.name;
  var format = req.params.format;
  var query = {'_user': user, 'Package': package, '_type': 'src'};
  var key = `${package}_${name}`.replace(/\W+/g, "");
  return packages.findOne(query).then(async function(x){
    var lazydata = ['yes', 'true'].includes((x['LazyData'] || "").toLowerCase());
    var datasets = x['_contents'] && x['_contents'].datasets || [];
    if(!name) {
      return res.send(datasets);
    } else {
      if(!format){
        return res.redirect(req.path.replace(/\/$/, '') + '/csv');
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
        {captureConditions: false, captureStreams: false});
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
    const now = new Date();
    if(err.stack){
      console.log("Got an R error. Restarting R...");
      reset_webr(60*1000); //restart R after error (but at most once per minute)
    }
  }).finally(function(){
    session.evalRVoid(`unlink('${key}.*')`);
    reset_webr(3600*1000); //restart R once per hour
  });
});

module.exports = router;
