
const { WebDriver, Builder, By, Key, until } = require('selenium-webdriver');
const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const os = require('os');
const url = require('url');
const browserStackLocal = require('browserstack-local').Local;
const ExtendedWebDriver = require('./ExtendedWebDriver');
const browserStackEnvironments = require('./browserstack-environments');
const helpers = require('./helpers');

// selenium-webdriver docs: https://seleniumhq.github.io/selenium/docs/api/javascript/module/selenium-webdriver/lib/webdriver.html

const BROWSERSTACK_HUB_URL = 'http://hub-cloud.browserstack.com/wd/hub';

const config = {
  browserHostUrl: '',
  browserStack: { 
    enabled: false, 
    user: '', 
    key: '', 
    localEnabled: false
  }
};

/**
 * Note: This config has to be loaded immediately and synchronously since the config values
 * are used for generating the Mocha test suites, and Mocha requires tests to be defined 
 * immediately and synchronously on script load. 
 */
(function initializeConfig() {

  // Determine which browser host endpoint to run tests against.
  const E2E_BROWSER_HOST = 'E2E_BROWSER_HOST';
  const PROD_HOST = 'https://browser.blockstack.org';
  config.browserHostUrl = process.env[E2E_BROWSER_HOST] || PROD_HOST;
  if (!process.env[E2E_BROWSER_HOST]) {
    console.warn(`WARNING: The browser host url was not set via the ${E2E_BROWSER_HOST} env var.. running tests against the production endpoint "${PROD_HOST}"`);
  } else {
    console.log(`Running e2e tests against endpoint ${config.browserHostUrl}`);
  }

  // Check environment vars for BrowserStack usage settings.
  const USE_BROWSERSTACK = 'USE_BROWSERSTACK';
  const BROWSERSTACK_AUTH = 'BROWSERSTACK_AUTH';
  config.browserStack.enabled = process.env[USE_BROWSERSTACK] && process.env[USE_BROWSERSTACK] !== 'false';
  if (config.browserStack.enabled) {
    const browserstackAuth = process.env[BROWSERSTACK_AUTH];
    if (!browserstackAuth) {
      const errMsg = `The BrowserStack auth must be set as environment variables. Use the format \`${BROWSERSTACK_AUTH}="user:key"\``;
      console.error(errMsg);
      throw new Error(errMsg);
    }
    // Auth string formatted as "user:key"
    [config.browserStack.user, config.browserStack.key] = browserstackAuth.trim().split(/:(.+)/);
  }

  /**
   * If the auth-browser host endpoint is set to localhost and BrowserStack testing is enabled
   * then BrowserStack Local must be used.
   * @see https://www.npmjs.com/package/browserstack-local
   * @see https://www.browserstack.com/local-testing
   */
  if (config.browserStack.enabled) {
    const parsedUrl = url.parse(config.browserHostUrl);
    config.browserStack.localEnabled = ['localhost', '127.0.0.1'].includes(parsedUrl.hostname);

    // Check if the host port is the expected port that is supported by BrowserStack Safari environments.
    const expectedPort = '5757';
    if (config.browserStack.localEnabled && parsedUrl.port !== expectedPort) {
      console.warn(`WARNING: BrowserStack Local is enabled but the host port is ${parsedUrl.port} rather than the expected port ${expectedPort}. ` + 
        `This may cause problems for BrowserStack Safari environments.. for more information see https://www.browserstack.com/question/664`);
    }
  }

  /**
   * If BrowserStack Local is enabled then the host url needs swapped from localhost to bs-local.com
   * This required due to a technical limitation with BrowserStack's Safari environments.
   * @see https://www.browserstack.com/question/759
   */
  if (config.browserStack.localEnabled) {
    const parsedUrl = url.parse(config.browserHostUrl);
    [ parsedUrl.hostname, parsedUrl.host ] = [ 'bs-local.com', undefined ];
    config.browserHostUrl = url.format(parsedUrl);
  }

})();


let blockStackLocalInstance;
before(async () => {
  // Check if BrowserStackLocal needs to be initialized before running tests..
  if (config.browserStack.localEnabled) {
    console.log(`BrowserStack is enabled the test endpoint is localhost, setting up BrowserStack Local..`);
    blockStackLocalInstance = new browserStackLocal();
    return await new Promise((resolve, reject) => {
      blockStackLocalInstance.start({ key: config.browserStack.key, force: 'true' }, (error) => {
        if (error) {
          console.error(`Error starting BrowserStack Local: ${error}`);
          reject(error)
        } else {
          console.log(`BrowserStack Local started`);
          resolve();
        }
      });
    });
  }
});
after(() => {
  // Check if BrowserStackLocal needs to be disposed off after running tests..
  if (blockStackLocalInstance && blockStackLocalInstance.isRunning()) {
    return new Promise((resolve, reject) => {
      blockStackLocalInstance.stop((error) => {
        if (error) {
          console.error(`Error stopping BrowserStack Local: ${error}`);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
});


/**
 * @typedef {Object} TestEnvironment
 * @property {string} description Human-readable name of the operating system & web browser.
 * @property {Promise<ExtendedWebDriver>} createDriver Promise that resolves to a ready-to-use WebDriver instance.
 */

/**
 * @generator
 * @param {string} user BrowserStack user credential.
 * @param {string} key BrowserStack key credential.
 * @yields {TestEnvironment}
 */
function* getBrowserstackEnvironments(user, key) {
  for (let capability of browserStackEnvironments) {
    capability = Object.assign(capability, {
      'browserstack.user': user,
      'browserstack.key': key
    });
    if (config.browserStack.localEnabled) {
      capability['browserstack.local'] = 'true';
    }
    yield {
      description: capability.desc,
      createDriver: async () => {
        const driver = await new Builder().
          usingServer(BROWSERSTACK_HUB_URL).
          withCapabilities(capability).
          build();
        await driver.manage().setTimeouts({ implicit: 1000, pageLoad: 10000 });
        return new ExtendedWebDriver(driver);
      }
    };
  }
}

/**
 * Generates test environments for the local machine. Always includes 'chrome' and 'firefox'.
 * If on macOS then also includes 'safari'. If on Windows then also includes 'edge'. 
 * @generator
 * @yields {TestEnvironment}
 */
function* getLocalSystemBrowserEnvironments() {
  const browsers = ['firefox', 'chrome'];

  // Ensure the browser webdriver binaries are added to env path
  require('chromedriver');
  require('geckodriver');

  if (process.platform === 'darwin') {
    browsers.push('safari');
  } else if (process.platform === 'win32') {
    browsers.push('edge');
  }
  for (let browser of new Set(browsers)) {
    yield {
      description: `${process.platform} ${browser}`,
      createDriver: async () => {
        const driver = await new Builder()
          .forBrowser(browser)
          .build();
        await driver.manage().setTimeouts({ implicit: 1000, pageLoad: 10000 });
        return new ExtendedWebDriver(driver);
      }
    };
  }
}

/**
 * @typedef {Object} TestInputs
 * @property {ExtendedWebDriver} driver A ready to use WebDriver instance.
 * @property {string} browserHostUrl The http endpoint hosting the browser.
 * @property {string} envDesc Human-readable name of the operating system & web browser.
 */

/**
 * @callback DefineTestsCallback
 * @param {TestInputs} testInputs
 * @returns {void}
 */

/**
 * @param {string} title Test suite title used in the `describe` statement.
 * @param {DefineTestsCallback} defineTests 
 *   Callback that is invoked for each test environment. 
 *   Mocha test (`it`, `step`, etc) should be defined inside in this callback. 
 *   Any test failures automatically trigger a screenshot that is written to file. 
 *   The WebDriver instance is automatically disposed/quitted at the end of the test suite. 
 */
function createTestSuites(title, defineTests) {

  const testEnvironments = config.browserStack.enabled 
    ? getBrowserstackEnvironments(config.browserStack.user, config.browserStack.key)
    : getLocalSystemBrowserEnvironments();

  for (const testEnvironment of testEnvironments) {

    describe(`${title} [${testEnvironment.description}]`, () => {

      /** @type {TestInputs} */
      const testInputs = {
        envDesc: testEnvironment.description,
        browserHostUrl: config.browserHostUrl,
        driver: {}
      };

      step('create selenium webdriver', async () => {
        const driver = await testEnvironment.createDriver();
        helpers.mixin(testInputs.driver, driver);
      }).timeout(120000);

      defineTests(testInputs)

      afterEach(function () {
        try {
          // If test failed then take a screenshot and save to local temp dir.
          if (this.currentTest.state === 'failed' && testInputs.driver.screenshot) {
            const errDir = path.resolve(os.tmpdir(), 'selenium-errors');
            if (!fs.existsSync(errDir)) { fs.mkdirSync(errDir, { recursive: true }); }
            const screenshotFile = path.resolve(errDir, `screenshot-${Date.now() / 1000 | 0}-${helpers.getRandomString(6)}.png`);
            return testInputs.driver.screenshot(screenshotFile).then(() => {
              console.log(`screenshot for failure saved to ${screenshotFile}`);
            }).catch(err => console.warn(`Error trying to create screenshot after test failure: ${err}`));
          }
        } catch (err) {
          console.warn(`Error trying to create screenshot after test failure: ${err}`);
        }
      });

      after(async () => {
        try {
          if (testInputs.driver.quit) {
            await testInputs.driver.quit();
          }
        } catch (err) {
          console.warn(`Error disposing driver after tests: ${err}`);
        }
      });

    });
  }
}

module.exports = createTestSuites;