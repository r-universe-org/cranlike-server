/* dummy token for GH api limits */
const tar = require('tar-stream');
const gunzip = require('gunzip-maybe');
const mime = require('mime');
const path = require('path');

/* Fields included in PACKAGES indices */
const pkgfields = {_id: 1, _type:1, _dependencies: 1, Filesize: '$_filesize', Distro: '$_distro',
  Package: 1, Version: 1, Depends: 1, Suggests: 1, License: 1,
  NeedsCompilation: 1, Imports: 1, LinkingTo: 1, Enhances: 1, License_restricts_use: 1,
  OS_type: 1, Priority: 1, License_is_FOSS: 1, Archs: 1, Path: 1, MD5sum: 1, Built: 1};

function qf(x, query_by_user_or_maintainer){
  const user = x._user;
  if(user == ":any"){
    delete x._user;
    if(query_by_user_or_maintainer){
      x['_indexed'] = true; //is this still needed?
    }
  } else if(query_by_user_or_maintainer) {
    x['_universes'] = user;
    delete x._user;
  }
  return x;
}

function fetch_github(url, opt = {}){
  if(process.env.REBUILD_TOKEN){
    opt.headers = opt.headers || {'Authorization': 'token ' + process.env.REBUILD_TOKEN};
  }
  return fetch(url, opt).then(function(response){
    return response.json().catch(e => response.text()).then(function(data){
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
  return packages.findOne({'_universes': user}).then(function(x){
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

function trigger_recheck(user, package, which = 'strong'){
  const rebuild_token = process.env.REBUILD_TOKEN;
  if(!rebuild_token)
    throw "No rebuild_token available";
  const url = `https://api.github.com/repos/r-universe/${user}/actions/workflows/recheck.yml/dispatches`;
  const params = {ref: 'master', inputs: {package: package, which: which}};
  return fetch_github(url, {
    method: 'POST',
    body: JSON.stringify(params),
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

function stream2string(stream) {
  return stream2buffer(stream).then(function(buf){
    return buf.toString("utf-8");
  });
}

function pipe_everything_to(stream, output) {
  return new Promise((resolve, reject) => {
    stream.on("end", () => resolve());
    stream.on("error", (err) => reject(err));
    stream.pipe(output);
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
          var input = bucket.openDownloadStream(hash);
          return extract_file(input, filename, res).finally(function(){
            input.destroy();
          });
        });
      }
    }
  });
}

//use the first match in findfile
function extract_file(input, findfile, res){
  var extract = tar.extract({allowUnknownFormat: true});
  var done = false;
  if(typeof findfile == 'string')
    findfile = [findfile];

  return new Promise(function(resolve, reject) {
    extract.on('entry', function(header, file_stream, next_entry) {
      if (!done && Array.isArray(findfile) && findfile.includes(header.name)) {
        done = true;
        var filename = header.name;
        if(res){
          var contenttype = mime.getType(filename);
          if(contenttype == 'text/plain' || filename.endsWith('.cff') || filename.endsWith('.Rmd')){
            contenttype = 'text/plain; charset=utf-8';
          }
          if(contenttype){
            res.type(contenttype);
          }
          if(header.size){
            res.set('Content-Length', header.size);
          }
        }
        var promise = res ? pipe_everything_to(file_stream, res) : stream2string(file_stream);
        promise.then(function(buf){
          resolve(buf);
        }).catch(function(err){
          reject(err);
        }).finally(function(){
          extract.destroy();
        });
      } else {
        add_to_list(header);
        next_entry();
      }
      file_stream.resume();
    });

    extract.on('finish', function() {
      if(dolist){
        res.send(matches);
      } else if (!done) {
        reject(`file "${findfile}" not found in tarball`);
        extract.destroy();
      }
    });

    extract.on('error', function(err) {
      reject(err);
      extract.destroy();
    });

    var matches = [];
    var dolist = findfile instanceof RegExp;
    function add_to_list(header){
      if(dolist && header.name){
        let m = header.name.match(findfile);
        if(m && m.length){
          matches.push(m.pop());
        }
      }
    }

    return input.pipe(gunzip()).pipe(extract);
  });
}

function extract_multi_files(input, files){
  var output = Array(files.length);
  return new Promise(function(resolve, reject) {
    function process_entry(header, filestream, next_entry) {
      var index = files.indexOf(header.name);
      filestream.on('end', next_entry)
      filestream.on('error', reject);
      if(index > -1){
        stream2buffer(filestream).then(function(buf){
          output[index] = buf;
        });
      } else {
        filestream.resume();
      }
    }
    function finish_stream(){
      resolve(output);
    }
    var extract = tar.extract({allowUnknownFormat: true})
      .on('entry', process_entry)
      .on('finish', finish_stream)
      .on('error', reject);
    input.pipe(gunzip()).pipe(extract);
  }).finally(function(){
    input.destroy();
  });
}

function get_extracted_file(query, filename){
  // try to get most recent build to avoid binaries for old versions
  return packages.find(query, {limit:1}).sort({"_created" : -1}).next().then(function(x){
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

function tar_index_files(input){
  let files = [];
  let extract = tar.extract({allowUnknownFormat: true});
  return new Promise(function(resolve, reject) {
    function process_entry(header, stream, next) {
      if(header.size > 0){
        files.push({
          filename: header.name,
          start: extract._buffer.shifted,
          end: extract._buffer.shifted + header.size
        });
      }
      stream.on('end', function () {
        next() //read for next file
      })
      stream.on('error', reject);
      stream.resume();
    }

    function finish_stream(){
      resolve({files: files, remote_package_size: extract._buffer.shifted});
    }

    var extract = tar.extract({allowUnknownFormat: true})
      .on('entry', process_entry)
      .on('finish', finish_stream)
      .on('error', reject);
    input.pipe(gunzip()).pipe(extract);
  });
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
  var alldeps = x['_dependencies'] || [];
  var deptypes = new Set(alldeps.map(dep => dep.role));
  deptypes.forEach(function(type){
    x[type] = alldeps.filter(dep => dep.role == type);
  });
  delete x['_dependencies'];
  return x;
}

function doc_to_dcf(doc){
  var x = unpack_deps(doc);
  delete x['_id'];
  delete x['_type'];
  delete x['Distro'];
  let keys = Object.keys(x);
  return keys.map(function(key){
    let val = x[key];
    if(Array.isArray(val))
      val = val.map(dep_to_string).join(", ");
    else if(key == 'Built')
      val = "R " + Object.values(val).join("; ");
    return key + ": " + val.toString().replace(/\s/gi, ' ');
  }).join("\n") + "\n\n";
}

function group_package_data(docs){
  var src = docs.find(x => x['_type'] == 'src');
  var failure = docs.find(x => x['_type'] == 'failure');
  if(!src){
    //no src found, package probably only has a 'failure' submission
    if(failure) {
      src = Object.assign({}, failure); //shallow copy to delete src.Version
      delete src.Version;
    } else {
      return null;
    }
  }
  if(failure){
    src._failure = {
      version: failure.Version,
      commit: failure._commit,
      buildurl: failure._buildurl,
      date: failure._created
    }
  }
  src._binaries = docs.filter(x => x.Built).map(function(x){
    return {
      r: x.Built.R,
      os: x['_type'],
      version: x.Version,
      date: x._created,
      distro: x['_type'] == 'linux' && x._distro || undefined,
      arch: x.Built.Platform && x.Built.Platform.split("-")[0] || undefined,
      commit: x._commit.id,
      fileid: x['_fileid'],
      status: x['_status'],
      check: x['_check'],
      buildurl: x['_buildurl']
    }
  });
  return src;
}

/* Use negative match, because on packages without compiled code Built.Platform is empty */
function match_macos_arch(platform){
  if(platform.match("arm64|aarch64")){
    return {$not : /x86_64/};
  }
  if(platform.match("x86_64")){
    return {$not : /aarch64/};
  }
  throw `Unknown platform: ${platform}`;
}

module.exports = {
  qf: qf,
  group_package_data: group_package_data,
  pkgfields: pkgfields,
  send_extracted_file : send_extracted_file,
  extract_file : extract_file,
  extract_multi_files: extract_multi_files,
  get_extracted_file: get_extracted_file,
  tar_index_files : tar_index_files,
  test_if_universe_exists : test_if_universe_exists,
  get_registry_info : get_registry_info,
  get_submodule_hash : get_submodule_hash,
  trigger_rebuild : trigger_rebuild,
  trigger_recheck : trigger_recheck,
  get_cran_desc : get_cran_desc,
  doc_to_dcf : doc_to_dcf,
  match_macos_arch : match_macos_arch
};

/* Tests
get_cran_desc("curl").then(console.log)
get_cran_desc("Ohmage").then(console.log)
get_cran_desc("doesnotexists").then(console.log)
fetch_github('https://api.github.com/users/jeroedfsdffdsn').catch(console.log)
get_registry_info("jeroen").then(console.log)
get_submodule_hash("jeroen", "curl").then(console.log)
*/