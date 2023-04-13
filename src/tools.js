/* dummy token for GH api limits */
const token = Buffer.from('Z2hwX2IxR2RLZGN0cEZGSXZYSHUyWnlpZ0dXNmxGcHNzbTBxNGJ0Vg==', 'base64').toString();
const tar = require('tar-stream');
const gunzip = require('gunzip-maybe');
const mime = require('mime');
const path = require('path');

function fetch_github(url, opt = {}){
  opt.headers = opt.headers || {'Authorization': 'token ' + token};
  return fetch(url, opt).then(function(response){
    return response.json().then(function(data){
      if (!response.ok) {
        throw "GitHub API returned HTTP " + response.status + ": " + (data.message || data);
      }
      return data;
    });
  });
}

/* true if we either have packages in the db, or an upstream monorepo exists */
function test_if_universe_exists(user){
  if(user === ':any') return Promise.resolve(true);
  const url = 'https://github.com/r-universe/' + user;
  const query = {'$or': [
    {'_user': user},
    {'_builder.maintainer.login': user, '_selfowned': true}
  ]};
  return packages.findOne(query).then(function(x){
    if(x) return true;
    console.log("Testing if " + url + " exists...");
    return fetch(url).then(response => response.ok);
  });
}

function get_registry_info(user){
  const url = 'https://api.github.com/repos/r-universe/' + user + '/actions/workflows/sync.yml/runs?per_page=1&status=completed';
  return fetch_github(url);
}

function get_submodule_hash(user, submodule){
  const url = `https://api.github.com/repos/r-universe/${user}/git/trees/HEAD`
  return fetch_github(url).then(function(data){
    var info = data.tree.find(file => file.path == submodule);
    if(info && info.sha){
      return info.sha;
    }
  });
}

function trigger_rebuild(run_path){
  const rebuild_token = process.env.REBUILD_TOKEN;
  if(!rebuild_token)
    throw "No rebuild_token available";
  const url = `https://api.github.com/repos/${run_path}/rerun-failed-jobs`;
  return fetch_github(url, {
    method: 'POST',
    headers: {'Authorization': 'token ' + rebuild_token}
  });
}

function parse_description(desc){
  var fields = desc.replace(/\n[\t ]+/g, ' ').split("\n")
  var package = fields.find(x => x.match(/^Package:/i));
  var version = fields.find(x => x.match(/^Version:/i));
  var date = fields.find(x => x.match(/^Date\/Publication:/i));
  var urls = fields.find(x => x.match(/^URL:/i));
  var bugreports = fields.find(x => x.match(/^BugReports:/i));
  var strings = `${urls} ${bugreports}`.trim().split(/[,\s]+/);
  var urlarray = strings.filter(x => x.match("https?://.*(github|gitlab|bitbucket)"))
    .map(x => x.replace('http://', 'https://'))
    .map(x => x.replace(/#.*/, ''));
  return {
    package: package ? package.substring(9) : "parse failure",
    version: version ? version.substring(9) : "parse failure",
    date: date ? date.substring(18) : "parse failure",
    urls: [...new Set(urlarray.map(x => x.replace(/\/issues$/, "")))]
  }
}

function get_cran_url(path){
  var mirror1 = `https://cloud.r-project.org/${path}`;
  var mirror2 = `http://cran.r-project.org/${path}`;
  return fetch(mirror1).then(function(res){
    if(res.status == 200 || res.status == 404){
      return res;
    }
    throw("Unexpected response from cran mirror; trying fallback");
  }).catch(function(){
    // Fallback when something is wrong with cloud mirror
    return fetch(mirror2);
  });
}

function get_cran_desc(package){
  return get_cran_url(`/web/packages/${package}/DESCRIPTION`).then(function(response){
    if (response.ok) {
      return response.text().then(parse_description);
    } else if(response.status == 404) {
      return get_cran_url(`/src/contrib/Archive/${package}/`).then(function(res2){
        if(res2.ok){
          return {package:package, version: "archived"};
        }
        if(res2.status == 404){
          return {package:package, version: null};
        }
      });
    }
    throw "Failed to lookup CRAN version";
  });
}

function etagify(x){
  return 'W/"' +  x + '"';
}

function stream2buffer(stream) {
    return new Promise((resolve, reject) => {
        const _buf = [];
        stream.on("data", (chunk) => _buf.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(_buf)));
        stream.on("error", (err) => reject(err));
    });
}

/* See https://www.npmjs.com/package/tar-stream#Extracting */
function tar_stream_file(hash, res, filename){
  var input = bucket.openDownloadStream(hash);
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
        reject(`File not found: ${filename}`);
      }
    }

    var dolist = filename instanceof RegExp;
    var matches = [];
    var hassent = false;
    var extract = tar.extract()
      .on('entry', process_entry)
      .on('finish', finish_stream);
    input.pipe(gunzip()).pipe(extract);
  }).finally(function(){
    input.destroy();
  });
}

function send_extracted_file(query, filename, req, res, next){
  return packages.findOne(query).then(function(x){
    if(!x){
      throw `Package ${query.Package} not found in ${query['_user']}`;
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

function extract_file(input, filename){
  var extract = tar.extract();
  var done = false;

  return new Promise(function(resolve, reject) {
    extract.on('entry', function(header, file_stream, next_entry) {
      if (!done && header.name === filename) {
        done = true;
        streamToString(file_stream).then(function(buf){
          resolve(buf);
        }).catch(function(err){
          reject(err);
        }).finally(function(){
          extract.destroy();
        });
      } else {
        next_entry();
      }
      file_stream.resume();
    });

    extract.on('finish', function() {
      if (!done) {
        reject(`file "${filename}" not found in tarball`);
        extract.destroy();
      }
    });

    extract.on('error', function(err) {
      reject(err);
      extract.destroy();
    });
    return input.pipe(gunzip()).pipe(extract);
  });
}

function extract_multi_files(input, files){
  var output = Array(files.length);
  return new Promise(function(resolve, reject) {
    function process_entry(header, filestream, next_file) {
      var index = files.indexOf(header.name);
      if(index > -1){
        stream2buffer(filestream).then(function(buf){
          output[index] = buf;
        });
      } else {
        filestream.resume();
      }
      next_file(); //ready for next entry
    }
    function finish_stream(){
      resolve(output);
    }
    var extract = tar.extract().on('entry', process_entry).on('finish', finish_stream);
    input.pipe(gunzip()).pipe(extract);
  }).finally(function(){
    input.destroy();
  });
}

function get_extracted_file(query, filename){
  return packages.findOne(query).then(function(x){
    if(!x){
      throw `Package ${query.Package} not found in ${query['_user']}`;
    }
    var hash = x.MD5sum;
    return bucket.find({_id: hash}, {limit:1}).hasNext().then(function(x){
      if(!x)
        throw `Failed to locate file in gridFS: ${hash}`;
      if(Array.isArray(filename)){
        return extract_multi_files(bucket.openDownloadStream(hash), filename);
      } else {
        return extract_file(bucket.openDownloadStream(hash), filename);
      }
    });
  });
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

var store = {};
function proxy_url(url, res){
  var key = url.replace(/.*\//, "");
  var now = new Date();
  var cache = store[key] || {};
  if((now - cache.time) < 300000){
    return res.type(cache.type).status(cache.status).send(cache.txt);
  }
  return fetch(url + '?nocache=' + Math.random()).then(function(response){
    if(response.status > 399){
      throw `GitHub pages sent HTTP ${response.status}`;
    }
    console.log(`Updating cache: ${key}`);
    var type = response.headers.get("Content-Type");
    return response.text().then(function(txt){
      store[key] = {time: now, type: type, status: response.status, txt: txt};
      return res.type(type).status(response.status).send(txt);
    });
  }).catch(function(err){
    console.log(`Failed to update ${key}: ${err.cause || err}`)
    if(cache.status){
      store[key].time = now; //keep cache another round
      return res.type(cache.type).status(cache.status).send(cache.txt);
    } else {
      res.status(500).send(err);
    }
  });
}

function send_frontend_html(req, res){
  send_dashboard(req, res, 'frontend.html')
}

function send_frontend_js(req, res){
  send_dashboard(req, res, 'frontend.js')
}

function send_dashboard(req, res, file){
  if(req.hostname.includes("localhost")){
    res.set('Cache-control', `no-store`)
    res.sendFile(path.join(__dirname, `../../dashboard/frontend/${file}`));
  } else {
    res.set('Cache-control', 'public, max-age=300');
    proxy_url(`https://r-universe-org.github.io/dashboard/frontend/${file}`, res);
  }
}

module.exports = {
  send_frontend_js : send_frontend_js,
  send_frontend_html : send_frontend_html,
  send_extracted_file : send_extracted_file,
  extract_file : extract_file,
  get_extracted_file: get_extracted_file,
  test_if_universe_exists : test_if_universe_exists,
  get_registry_info : get_registry_info,
  get_submodule_hash : get_submodule_hash,
  trigger_rebuild : trigger_rebuild,
  get_cran_desc : get_cran_desc
};

/* Tests
get_cran_desc("curl").then(console.log)
get_cran_desc("Ohmage").then(console.log)
get_cran_desc("doesnotexists").then(console.log)
fetch_github('https://api.github.com/users/jeroedfsdffdsn').catch(console.log)
get_registry_info("jeroen").then(console.log)
get_submodule_hash("jeroen", "curl").then(console.log)
*/