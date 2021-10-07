const https = require('https');

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
  const url = 'https://github.com/r-universe/' + user;
  return packages.findOne({_user : user}).then(function(x){
    if(x) return true;
    console.log("Testing if " + url + " exists...");
    return http_url_exists(url);
  });
}

module.exports = {
  test_if_universe_exists : test_if_universe_exists
};
