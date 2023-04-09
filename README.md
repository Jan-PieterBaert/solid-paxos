# Solid paxos

A library to use an adjusted Paxos protocol with Solid inboxes and Linked Data Notifications.

## Algorithm

The algorithm is the general Paxos algorithm with two adjustments:
- every message has an accompanying Acknowledgement, allowing the sender to be sure the Linked Data Notification was delivered in the inbox
- the second step of the second phase (the `Accepted` step) has been extended to allow a user to reject a consensus value.

## Starting processing

To start the processing of inbox elements and sending outbox elements, the `inboxCron` and `outboxCron` functions have to be executed once, they will in turn start the cronjobs.

## Starting a consensus

To start a consensus, you must use the `sendPrepare` function and give the Paxos element, this should be an object similar to the following:
```json
{
  "name": "The name of the paxos algorithm, used as an ID",
  "instance": "The instance of the paxos algorithm, usually this increases by 1 every time a new consensus is started",
  "round": "The paxos round of one instance",
  "inbox": "http://example.com/inbox/of/the/proposer",
  "inboxArray": ["list of", "inboxes of all acceptors"]
}
```
Furthermore, the value to be agreed upon should be stored in `${name}|${instance}|value to accept`.

This library will then exchange messages with the acceptors automatically (via the cronjobs) until user interaction is required to accept or reject the value.

## Accepting or rejecting a value

The list of pending accepts to which the user has to respond can be found in the localStorage with key `"awaitingAccepts"`.
To respond to this pending accept, the `createAccepted` function should be used with the element to which is replied upon as first argument and a boolean indicating whether it is accepted as the second.

When one of the Acceptors rejects the value, the instance is noted as failed.
