/* eslint-disable */

const { before } = require('mocha')
const chai = require('chai')
chai.use(require('chai-as-promised'))
require('@babel/register')({ extensions: ['.js', '.ts'] })

if (process.argv.indexOf('--watch') >= 0) {
  before(() => process.stdout.write('\u001b[2J\u001b[1;1H\u001b[3J'))
}
