/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2015 Apigee Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

'use strict';

var _ = require('lodash');
var async = require('async');
var fs = require('fs');
var helpers = require('../lib/helpers');
var JsonRefs = require('json-refs');
var paddingAmount = 18;
var path = require('path');
var pkg = require('../package.json');
var program = require('commander');
var request = require('superagent');
var S = require('string');
var YAML = require('js-yaml');

var exitWithError = function exitWithError (msg) {
  console.error();
  console.error('  error: ' + msg);
  console.error(); // Here only to match the output of commander.js

  process.exit(1);
};
var getDocument = function getDocument (pathOrUrl, callback) {
  var parseContent = function parseContent (content) {
    var err;
    var response;

    try {
      switch (path.extname(pathOrUrl)) {
      case '.yaml':
      case '.yml':
        response = YAML.safeLoad(content);

        break;

      default:
        response = JSON.parse(content);
      }
    } catch (e) {
      err = e;
    }

    callback(err, response);
  };

  if (!_.isString(pathOrUrl)) {
    callback();
  } else if (/^https?:\/\//.test(pathOrUrl)) {
    request.get(pathOrUrl)
      .set('user-agent', 'apigee-127/swagger-tools')
      .end(function (res) {
        parseContent(res.text);
      });
  } else {
    try {
      parseContent(fs.readFileSync(path.resolve(pathOrUrl), 'utf-8'));
    } catch (err) {
      callback(err);
    }
  }
};

var handleUnidentifiableVersion = function handleUnidentifiableVersion (path) {
  return exitWithError('Unable to identify the Swagger version for document: ' + path);
};

var getDocuments = function getDocuments (pathsAndOrUrls, callback) {
  var resolvedDocuments = {};

  async.map(pathsAndOrUrls, getDocument, function (err, documents) {
    if (_.isUndefined(err)) {
      _.each(documents, function (document, index) {
        if (!document) {
          return;
        }

        if (index === 0) {
          if (document.swagger) {
            resolvedDocuments.swaggerObject = document;
          } else if (document.swaggerVersion) {
            resolvedDocuments.resourceListing = document;
          } else {
            handleUnidentifiableVersion(pathsAndOrUrls[index]);
          }
        } else if (_.isUndefined(resolvedDocuments.swaggerObject)) {
          if (!resolvedDocuments.apiDeclarations) {
            resolvedDocuments.apiDeclarations = [];
          }

          resolvedDocuments.apiDeclarations.push(document);
        }
      });
    }

    callback(err, resolvedDocuments);
  });
};

var handleUnsupportedVersion = function handleUnsupportedVersion (version) {
  exitWithError('Unsupported Swagger version: ' + version);
};

var handleUnknownCommand = function handleUnknownCommand (command) {
  // Using log instead of error since commander.js uses console.log for help output
  console.log(program._name + ' does not support the ' + command + ' command.');

  program.outputHelp();
};

var printValidationResults = function printValidationResults (version, apiDOrSO, apiDeclarations, results,
                                                              printSummary, endProcess) {
  var hasErrors = helpers.getErrorCount(results) > 0;
  var stream = hasErrors ? console.error : console.log;
  var pluralize = function pluralize (string, count) {
    return count === 1 ? string : string + 's';
  };
  var printErrorsOrWarnings = function printErrorsOrWarnings (header, entries, indent) {
    if (header) {
      stream(header + ':');
      stream();
    }

    _.each(entries, function (entry) {
      stream(new Array(indent + 1).join(' ') + JsonRefs.pathToPointer(entry.path) + ': ' + entry.message);

      if (entry.inner) {
        printErrorsOrWarnings (undefined, entry.inner, indent + 2);
      }
    });

    if (header) {
      stream();
    }
  };
  var errorCount = 0;
  var warningCount = 0;

  stream();

  if (results.errors.length > 0) {
    errorCount += results.errors.length;

    printErrorsOrWarnings('API Errors', results.errors, 2);
  }

  if (results.warnings.length > 0) {
    warningCount += results.warnings.length;

    printErrorsOrWarnings('API Warnings', results.warnings, 2);
  }

  if (results.apiDeclarations) {
    results.apiDeclarations.forEach(function (adResult, index) {
      if (!adResult) {
        return;
      }

      var name = apiDeclarations[index].resourcePath || index;

      if (adResult.errors.length > 0) {
        errorCount += adResult.errors.length;

        printErrorsOrWarnings('  API Declaration (' + name + ') Errors', adResult.errors, 4);
      }

      if (adResult.warnings.length > 0) {
        warningCount += adResult.warnings.length;

        printErrorsOrWarnings('  API Declaration (' + name + ') Warnings', adResult.warnings, 4);
      }
    });
  }

  if (printSummary) {
    if (errorCount > 0) {
      stream(errorCount + ' ' + pluralize('error', errorCount) + ' and ' + warningCount + ' ' +
                    pluralize('warning', warningCount));
    } else {
      stream('Validation succeeded but with ' + warningCount + ' ' + pluralize('warning', warningCount));
    }
  }

  stream();

  if (errorCount > 0 && endProcess) {
    process.exit(1);
  }
};

// Set name and version
program._name = 'swagger-tools';
program.version(pkg.version);

program
  .command('convert <resourceListing> [apiDeclarations...]')
  .description('Converts Swagger 1.2 documents to a Swagger 2.0 document')
  .option('-n, --no-validation', 'disable pre-conversion validation of the Swagger document(s)')
  .option('-y, --yaml', 'output as YAML instead of JSON')
  .action(function (resourceListing, apiDeclarations) {
    var doConvert = function doConvert (err, converted) {
      if (err) {
        if (err.failedValidation) {
          console.error();
          console.error(err.message + ' (Run with --no-validation to skip validation)');

          return printValidationResults('1.2', resourceListing, apiDeclarations,
                                        {
                                          errors: err.errors,
                                          warnings: err.warnings,
                                          apiDeclarations: err.apiDeclarations
                                        }, true, true);
        } else {
          return exitWithError(err.message);
        }
      } else {
        console.log();
        console.log(this.yaml ? YAML.safeDump(converted, {indent: 2}) : JSON.stringify(converted, null, 2));
        console.log();
      }
    }.bind(this);

    getDocuments([resourceListing].concat(apiDeclarations || []), function (err, documents) {
      if (err) {
        return exitWithError(err.message);
      }

      if (_.isUndefined(documents.resourceListing)) {
        return handleUnidentifiableVersion(resourceListing);
      }

      helpers.getSpec('1.2').convert(documents.resourceListing, documents.apiDeclarations, this.validation === false,
                                     doConvert);
    }.bind(this));
  });

program
  .command('help [command]')
  .description('Display help information')
  .action(function (command) {
    var theCommand;

    if (!_.isUndefined(command)) {
      theCommand = _.find(this.parent.commands, function (cmd) {
        return cmd._name === command;
      });

      if (_.isUndefined(theCommand)) {
        return handleUnknownCommand(command);
      }
    }

    if (_.isUndefined(theCommand)) {
      program.outputHelp();
    } else {
      theCommand.help();
    }
  });

program
  .command('info <version>')
  .description('Display information about the Swagger version requested')
  .action(function (version) {
    var spec = helpers.getSpec(version, false);

    if (_.isUndefined(spec)) {
      return handleUnsupportedVersion(version);
    }

    console.log();
    console.log('Swagger ' + version + ' Information:');
    console.log();

    console.log('  ' + S('documentation url').padRight(paddingAmount).s + spec.docsUrl);
    console.log('  ' + S('schema(s) url').padRight(paddingAmount).s + spec.schemasUrl);
    console.log();
  });

// We have to use command+usage because commander.js does not handle the following properly:
//   .command('validate <resourceListingOrSwaggerDoc> [apiDeclarations ...]')

program
  .command('validate <resourceListingOrSwaggerDoc> [apiDeclarations...]')
  .option('-v, --verbose', 'display verbose output')
  .description('Display validation results for the Swagger document(s)')
  .action(function (rlOrSO, apiDeclarations) {
    var verbose = this.verbose;

    getDocuments([rlOrSO].concat(apiDeclarations || []), function (err, documents) {
      if (err) {
        return exitWithError(err.message);
      }

      var adDocs = documents.apiDeclarations || [];
      var rlDoc = documents.resourceListing;
      var soDoc = documents.swaggerObject;
      var soArgs = [];
      var spec;
      var version;

      if (soDoc && soDoc.swagger) {
        version = soDoc.swagger;
      } else if (rlDoc) {
        version = rlDoc.swaggerVersion;
      }

      spec = helpers.getSpec(version, false);

      if (_.isUndefined(spec)) {
        return handleUnsupportedVersion(version);
      }

      if (_.isUndefined(rlDoc)) {
        soArgs = [soDoc];
      } else {
        soArgs = [rlDoc, adDocs];
      }

      soArgs.push(function (err, results) {
        var isError = helpers.getErrorCount(results) > 0;
        var stream =  isError ? console.error : console.log;
        var printValidationDetails = function () {
          if (!verbose) {
            return;
          }

          stream();
          stream('Validation Details:');
          stream();
          stream('  Swagger Version: %s', version);

          if (version === '1.2') {
            stream('  Swagger files:');
            stream();
            stream('    Resource Listing: %s', rlOrSO);
            stream('    API Declarations:');
            stream();

            _.each(apiDeclarations, function (ad) {
              stream('      %s', ad);
            });
          } else {
            stream('  Swagger file: %s', rlOrSO);
          }
        };

        if (err) {
          return exitWithError(err.message);
        }

        if (helpers.formatResults(results)) {
          err = new Error('Swagger document' + (version === '1.2' ? '(s)' : '') +
                          (isError ? ' failed validation' : ' has warnings'));

          err.results = results;
        }

        if (err) {
          if (process.env.NODE_ENV === 'test') {
            throw err;
          } else {
            printValidationDetails();

            printValidationResults(version, rlDoc || soDoc, adDocs, results, true, true);
          }
        } else if (verbose) {
          printValidationDetails();

          stream();

          if (version === '1.2') {
            stream('Swagger documents are valid');
          } else {
            stream('Swagger document is valid');
          }
        }
      });

      spec.validate.apply(spec, soArgs);
    });
  });

program
  .command('*', null, {noHelp: true}) // null is required to avoid the implicit 'help' command being added
  .action(function(cmd){
    handleUnknownCommand(cmd);
  });

module.exports.execute = function execute (cliArgs) {
  if (_.isUndefined(cliArgs)) {
    cliArgs = process.argv || [];
  }

  var realArgs = cliArgs.slice(2);

  if (!realArgs.length) {
    program.outputHelp();
  } else {
    // Reset state (primarily for testing)
    _.each(program.commands, function (command) {
      switch (command._name) {
      case 'convert':
        command.yaml = false;

        break;

      case 'validate':
        command.verbose = false;

        break;
      }
    });

    program.parse(cliArgs);
  }
};

module.exports.printValidationResults = printValidationResults;