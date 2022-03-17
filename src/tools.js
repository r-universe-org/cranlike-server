const https = require('https');
const axios = require('axios');

/* dummy token for GH api limits */
const token = Buffer.from('Z2hwX2IxR2RLZGN0cEZGSXZYSHUyWnlpZ0dXNmxGcHNzbTBxNGJ0Vg==', 'base64').toString();

/* Promisify http */
function http_url_exists(url){
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      resolve(res.statusCode == 200);
    });
    req.on('error', reject);
    req.end();
  });
};

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
    return http_url_exists(url);
  });
}

function get_registry_info(user){
  const url = 'https://api.github.com/repos/r-universe/' + user + '/actions/workflows/sync.yml/runs?per_page=1&status=completed';
  return axios.get(url, {
    headers: {
      'Authorization': 'token ' + token
    }
  }).then(function(x){return x.data}).catch(err => {
    const data = err.response.data;
    throw "Failed to query GitHub: HTTP " + err.response.status + ": " + (data.message || data);
  });
}

function get_submodule_hash(user, submodule){
  const url = `https://api.github.com/repos/r-universe/${user}/git/trees/HEAD`
  return axios.get(url, {
    headers: {
      'Authorization': 'token ' + token
    }
  }).then(function(res){
    var info = res.data.tree.find(file => file.path == submodule);
    if(info && info.sha){
      return info.sha;
    }
  }).catch(err => {
    const data = err.response.data;
    throw "Failed to query GitHub: HTTP " + err.response.status + ": " + (data.message || data);
  });
}

function trigger_rebuild(run_path){
  const rebuild_token = process.env.REBUILD_TOKEN;
  if(!rebuild_token)
    throw "No rebuild_token available";
  const url = `https://api.github.com/repos/${run_path}/rerun-failed-jobs`;
  return axios.post(url, {}, {
    headers: {
      'Authorization': 'token ' + rebuild_token
    }
  }).then(function(x){
    return x.data;
  }).catch(err => {
    const data = err.response.data;
    throw `${data.message || data} (HTTP ${err.response.status} at ${run_path})`;
  });
}

module.exports = {
  test_if_universe_exists : test_if_universe_exists,
  get_registry_info : get_registry_info,
  get_submodule_hash : get_submodule_hash,
  trigger_rebuild : trigger_rebuild
};
