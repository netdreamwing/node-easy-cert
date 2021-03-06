'use strict';

delete require.cache['./certGenerator'];

var path = require('path'),
    fs = require('fs'),
    color = require('colorful'),
    certGenerator = require('./certGenerator'),
    util = require('./util'),
    Errors = require('./errorConstants'),
    https = require('https'),
    AsyncTask = require('async-task-mgr'),
    winCertUtil = require('./winCertUtil'),
    exec = require('child_process').exec;

var DOMAIN_TO_VERIFY_HTTPS = 'localtest.me';

function getPort() {
  return new Promise(function (resolve, reject) {
    var server = require('net').createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, function () {
      var port = server.address().port;
      server.close(function () {
        resolve(port);
      });
    });
  });
}

function CertManager(options) {
  options = options || {};
  var rootDirName = util.getDefaultRootDirName();
  var rootDirPath = options.rootDirPath || path.join(util.getUserHome(), '/' + rootDirName + '/');

  if (options.defaultCertAttrs) {
    certGenerator.setDefaultAttrs(options.defaultCertAttrs);
  }

  var certDir = rootDirPath,
      rootCAcrtFilePath = path.join(certDir, 'falcon.crt'),
      rootCAkeyFilePath = path.join(certDir, 'falcon.key'),
      createCertTaskMgr = new AsyncTask();
  var cacheRootCACrtFileContent = void 0,
      cacheRootCAKeyFileContent = void 0;
  var rootCAExists = false;

  if (!fs.existsSync(certDir)) {
    try {
      fs.mkdirSync(certDir, '0777');
    } catch (e) {
      console.log('===========');
      console.log('failed to create cert dir ,please create one by yourself - ' + certDir);
      console.log('===========');
    }
  }

  function getCertificate(hostname, certCallback) {
    if (!_checkRootCA()) {
      console.log(color.yellow('please generate root CA before getting certificate for sub-domains'));
      certCallback && certCallback(Errors.ROOT_CA_NOT_EXISTS);
      return;
    }
    var keyFile = path.join(certDir, '__hostname.key'.replace(/__hostname/, hostname)),
        crtFile = path.join(certDir, '__hostname.crt'.replace(/__hostname/, hostname));

    if (!cacheRootCACrtFileContent || !cacheRootCAKeyFileContent) {
      cacheRootCACrtFileContent = fs.readFileSync(rootCAcrtFilePath, { encoding: 'utf8' });
      cacheRootCAKeyFileContent = fs.readFileSync(rootCAkeyFilePath, { encoding: 'utf8' });
    }

    createCertTaskMgr.addTask(hostname, function (callback) {
      if (!fs.existsSync(keyFile) || !fs.existsSync(crtFile)) {
        try {
          var result = certGenerator.generateCertsForHostname(hostname, {
            cert: cacheRootCACrtFileContent,
            key: cacheRootCAKeyFileContent
          });
          fs.writeFileSync(keyFile, result.privateKey);
          fs.writeFileSync(crtFile, result.certificate);
          callback(null, result.privateKey, result.certificate);
        } catch (e) {
          callback(e);
        }
      } else {
        callback(null, fs.readFileSync(keyFile), fs.readFileSync(crtFile));
      }
    }, function (err, keyContent, crtContent) {
      if (!err) {
        certCallback(null, keyContent, crtContent);
      } else {
        certCallback(err);
      }
    });
  }

  function clearCerts(cb) {
    util.deleteFolderContentsRecursive(certDir);
    cb && cb();
  }

  function isRootCAFileExists() {
    return fs.existsSync(rootCAcrtFilePath) && fs.existsSync(rootCAkeyFilePath);
  }

  function generateRootCA(config, certCallback) {
    if (!config || !config.commonName) {
      console.error(color.red('The "config.commonName" for rootCA is required, please specify.'));
      certCallback(Errors.ROOT_CA_COMMON_NAME_UNSPECIFIED);
      return;
    }

    if (isRootCAFileExists()) {
      if (config.overwrite) {
        startGenerating(config.commonName, certCallback);
      } else {
        console.error(color.red('The rootCA exists already, if you want to overwrite it, please specify the "config.overwrite=true"'));
        certCallback(Errors.ROOT_CA_EXISTED);
      }
    } else {
      startGenerating(config.commonName, certCallback);
    }

    function startGenerating(commonName, cb) {
      // clear old certs
      clearCerts(function () {
        console.log(color.green('temp certs cleared'));
        try {
          var result = certGenerator.generateRootCA(commonName);
          fs.writeFileSync(rootCAkeyFilePath, result.privateKey);
          fs.writeFileSync(rootCAcrtFilePath, result.certificate);

          console.log(color.green('rootCA generated'));
          console.log(color.green(color.bold('PLEASE TRUST the falcon.crt in ' + certDir)));

          cb && cb(null, rootCAkeyFilePath, rootCAcrtFilePath);
        } catch (e) {
          console.log(color.red(e));
          console.log(color.red(e.stack));
          console.log(color.red('fail to generate root CA'));
          cb && cb(e);
        }
      });
    }
  }

  function getRootCAFilePath() {
    return isRootCAFileExists() ? rootCAcrtFilePath : '';
  }

  function getRootDirPath() {
    return rootDirPath;
  }

  function _checkRootCA() {
    if (rootCAExists) {
      return true;
    }

    if (!isRootCAFileExists()) {
      console.log(color.red('can not find falcon.crt or falcon.key'));
      console.log(color.red('you may generate one'));
      return false;
    } else {
      rootCAExists = true;
      return true;
    }
  }

  function ifRootCATrusted(callback) {
    if (!isRootCAFileExists()) {
      callback && callback(new Error('ROOTCA_NOT_EXIST'));
    } else if (/^win/.test(process.platform)) {
      winCertUtil.ifWinRootCATrusted().then(function (ifTrusted) {
        callback && callback(null, ifTrusted);
      }).catch(function (e) {
        callback && callback(null, false);
      });
    } else {
      var HTTPS_RESPONSE = 'HTTPS Server is ON';
      // localtest.me --> 127.0.0.1
      getCertificate(DOMAIN_TO_VERIFY_HTTPS, function (e, key, cert) {
        getPort().then(function (port) {
          if (e) {
            callback && callback(e);
            return;
          }
          var server = https.createServer({
            ca: fs.readFileSync(rootCAcrtFilePath),
            key: key,
            cert: cert
          }, function (req, res) {
            res.end(HTTPS_RESPONSE);
          }).listen(port);

          // do not use node.http to test the cert. Ref: https://github.com/nodejs/node/issues/4175
          var testCmd = 'curl https://' + DOMAIN_TO_VERIFY_HTTPS + ':' + port;
          exec(testCmd, { timeout: 1000 }, function (error, stdout, stderr) {
            server.close();
            if (error) {
              callback && callback(null, false);
            }
            if (stdout && stdout.indexOf(HTTPS_RESPONSE) >= 0) {
              callback && callback(null, true);
            } else {
              callback && callback(null, false);
            }
          });
        }).catch(callback);
      });
    }
  }

  return {
    getRootCAFilePath: getRootCAFilePath,
    generateRootCA: generateRootCA,
    getCertificate: getCertificate,
    clearCerts: clearCerts,
    isRootCAFileExists: isRootCAFileExists,
    ifRootCATrusted: ifRootCATrusted,
    getRootDirPath: getRootDirPath
  };
}

module.exports = CertManager;