"use strict"

const _ = require('lodash')
const superagent = require('superagent-promise')(require('superagent'), Promise)
const uuid = require ('uuid4')
const sender = require('five-bells-sender')
const EventEmitter = require('events').EventEmitter

const Config = require('./config')
const Log = require('./log')

const NotFoundError = require('../errors/not-found-error')

// TODO exception handling
module.exports = class Ledger extends EventEmitter {
  static constitute () { return [Config, Log] }
  constructor (config, log) {
    super()
    this.config = config.data
    this.log = log('ledger')
    this.ledgerUri = this.config.getIn(['ledger', 'uri'])
    this.ledgerUriPublic = this.config.getIn(['ledger', 'public_uri'])
  }

  // TODO caching
  * getInfo (uri) {
    const ledgerUri = uri || this.ledgerUri
    let response

    try {
      this.log.info('getting ledger info ' + ledgerUri)
      response = yield superagent.get(ledgerUri).end()
    } catch (err) {
      if (err.status !== 422) throw err
    }

    return response.body
  }

  * subscribe () {
    try {
      this.log.info('subscribing to ledger ' + this.ledgerUri)
      yield superagent
        .put(this.ledgerUri + '/subscriptions/' + uuid())
        .auth(this.config.getIn(['ledger', 'admin', 'name']), this.config.getIn(['ledger', 'admin', 'pass']))
        .send({
          'owner': this.config.getIn(['ledger', 'admin', 'name']),
          'event': '*',
          'subject': '*',
          'target': this.config.getIn(['server', 'base_uri']) + '/notifications' // TODO server.base_uri???
        })
        .end()
    } catch (err) {
      if (err.status !== 422) throw err
    }
  }

  emitTransferEvent (transfer) {
    this.log.debug('received notification for transfer ' + transfer.id)
    const affectedAccounts = _.uniq(transfer.debits.map((debit) => debit.account)
      .concat(transfer.credits.map((credit) => credit.account)))
      .map((uri) => {
        if (!_.startsWith(uri, this.ledgerUriPublic + '/accounts/')) {
          throw new Error('received an invalid notification')
        }

        return uri.slice(this.ledgerUriPublic.length + 10)
      })

    // TODO who should emit this events? might make more sense if the event
    // has the payment object, not transfer
    this.log.debug('posting notification to accounts ' + affectedAccounts.join(','))
    affectedAccounts.forEach((account) => this.emit('transfer_' + account, transfer))
  }

  * getAccount (user, admin) {
    let response

    try {
      response = yield superagent
        .get(this.ledgerUri + '/accounts/' + user.username)
        .auth(admin ? this.config.getIn(['ledger', 'admin', 'name']) : user.username, admin ? this.config.getIn(['ledger', 'admin', 'pass']): user.password)
        .end()
    } catch (e) {
      if (e.response && e.response.body && e.response.body.id === 'NotFoundError') {
        throw new NotFoundError(e.response.body.message)
      }
    }

    return response.body
  }

  * createAccount(user) {
    let data = {
      name: user.username,
      balance: user.balance ? ''+user.balance : '1000'
    }

    if (user.password) {
      data.password = user.password
    }

    let response

    try {
      response = yield superagent
        .put(this.ledgerUri + '/accounts/' + user.username)
        .send(data)
        // TODO do we need auth?
        .auth(this.config.getIn(['ledger', 'admin', 'name']), this.config.getIn(['ledger', 'admin', 'pass']))
    } catch (e) {
      // TODO handle
    }

    return response.body
  }

  findPath(options) {
    let pathOptions = {
      sourceAccount: this.ledgerUriPublic + '/accounts/' + options.username,
      destinationAccount: options.destination.accountUri
    }

    if (options.sourceAmount) {
      pathOptions.sourceAmount = options.sourceAmount
    } else {
      pathOptions.destinationAmount = options.destinationAmount
    }

    return sender.findPath(pathOptions)
  }

  * transfer(options) {
    let response
    let sourceAccount = this.ledgerUriPublic + '/accounts/' + options.username

    // Interledger
    if (options.destination.type === 'foreign') {
      response = yield sender.executePayment(options.path, {
        sourceAccount: sourceAccount,
        sourcePassword: options.password,
        destinationAccount: options.destination.accountUri,
        additionalInfo: {
          source_account: sourceAccount,
          source_amount: options.path[0].source_transfers[0].debits[0].amount,
          destination_account: options.destination.accountUri,
          destination_amount: options.path[0].destination_transfers[0].credits[0].amount
        }
      })

      response = response[0]
    }
    else {
      const paymentId = uuid()

      response = yield superagent
        .put(this.ledgerUri + '/transfers/' + paymentId)
        .send({
          debits: [{
            account: sourceAccount,
            amount: options.destinationAmount,
            authorized: true
          }],
          credits: [{
            account: options.destination.accountUri,
            amount: options.destinationAmount
          }],
          expires_at: "2016-06-16T00:00:01.000Z"
        })
        .auth(options.username, options.password)

      response = response.body
    }

    return response
  }
}
