import {
    fetch
} from "@inrupt/solid-client-authn-browser";
import * as jsonld from "jsonld";
import * as cron from "cron";
import {
    QueryEngine
} from "@comunica/query-sparql-solid";

// TODO: add documentation to every function
// TODO: make it typescript?
// TODO: Add Nack

/**
 * Delete an element in the inbox specified by the url
 */
export async function deleteInboxElem(url) {
    await fetch(url, {
        method: "DELETE",
        cors: "cors",
    });
}

/*
 * Load the content of the given url and add a base to the document if necessary
 */
export async function loadContentOfUrl(url, addBase = true) {
    const response = await fetch(url, {
        cors: "cors",
    });
    let content = await response.text();

    // Add base to doc if not yet. Fixing relative IRIs.
    if (!content.includes("@base") && !content.includes("BASE") && addBase) {
        content = `@base <${url.split("#")[0]}> .\n${content}`;
    }
    return content;
}

const orgNsActivitystreamsObject = "https://www.w3.org/ns/activitystreams#object";
export async function getPaxosMessage(content, url) {
    let json_ld = await jsonld.expand(JSON.parse(content));
    let retvals = [];
    for (const content of json_ld) {
        console.debug(content);
        let data = content;
        console.debug(data);
        if (data["@type"].includes(orgNsActivitystreamsObject)) {
            continue;
        }
        let id = data["@id"];
        data = data[orgNsActivitystreamsObject][0];
        console.debug(data);
        // TODO: add null check for each of the fields
        let retval = {
            url: url,
            type: data["@type"][0]?.split("http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#")[1],
            instance: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#instance"]?.map(
                (i) => i["@value"]
            )[0],
            round: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#round"]?.map(
                (i) => i["@value"]
            )[0],
            id: id,
            acceptors: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#acceptors"]?.map(
                (i) => i["@value"]
            ),
            proposer: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#proposer"]?.map(
                (i) => i["@value"]
            ),
            from: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#from"]?.map(
                (i) => i["@value"]
            )[0],
            value: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#value"]?.map(
                (i) => i["@value"]
            )[0],
            accepted: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#acceptedStatus"]?.map(
                (i) => i["@value"]
            )[0],
            ackKey: data["http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#ackKey"]?.map(
                (i) => i["@value"]
            )[0],
        };
        retvals.push(retval);
    }
    return retvals[0];
}

export async function getInboxElements(content, engine, inbox) {
    const query = `
      PREFIX ldp: <http://www.w3.org/ns/ldp#>
      SELECT ?element WHERE {
        ?element a ldp:Resource, <http://www.w3.org/ns/iana/media-types/application/ld+json#Resource> .
      }
      `;

    const bindings = await (
        await engine.queryBindings(query, {
            sources: [{
                type: "stringSource",
                value: content,
                mediaType: "text/n3",
                baseIRI: inbox.split("#")[0],
            }, ],
        })
    ).toArray();
    return bindings.map((row) => {
        return row.get("element");
    });
}

export async function getAllInboxElements(inbox) {
    const engine = new QueryEngine();
    const inboxContent = await loadContentOfUrl(inbox);

    let elements = await getInboxElements(inboxContent, engine, inbox);
    let retval = [];
    for (const element of elements) {
        let content = await loadContentOfUrl(element.id, false);
        const message = await getPaxosMessage(content, element.id);
        // Process the inbox element, since it might get deleted
        if (processInboxElem(message)) {
            retval.push(message);
        }
    }
    return retval;
}

/*
 * Process an inbox element, this means a few things
 * 1 if it's not a paxos message, ignore
 * 2 if it's a paxos message of which the round and instance can no longer be promised, delete the item and send a nack
 * 3 if it's a Prepare message, send a Promise and update the lastPromised
 * 4 if it's a Promise message, wait for an answer from all Acceptors
 * 5 if it's a Accept message, await user interaction for response
 * 6 if it's a (Not) Accepted message, await answer from all Acceptors and write down the consensus
 * 7 in all cases: send an ack or nack
 */
export async function processInboxElem(element) {
    const key = getKeyFromElement(element);
    let data = JSON.parse(localStorage.getItem(key)) || {
        lastPromised: -Infinity
    };

    console.debug("Inbox element", element);

    // below is option 2
    if (Number(element.round) < Number(data.lastPromised)) {
        console.debug("Inbox item has a round that can't be promised to anymore, ignoring");
        console.debug(`element is: ${JSON.stringify(element)}, saved data is ${JSON.stringify(data)}`);
        deleteInboxElem(element.url).then(() => {
            console.debug(`Deleted item with url: ${element.url}`);
        });
        // TODO: send nack
        return false;
    }
    // below is option 3
    if (element.type === "Prepare") {
        // answer to Prepare message in separate function
        await answerToPrepare(element);
    }
    // below is option 4
    if (element.type === "Promise") {
        await answerToPromise(element);
        // answer to Promise message in separate function
    }
    // below is option 5
    if (element.type === "Accept") {
        await processAccept(element);
        // answer to Accept message in separate function
    }
    // below is option 6
    if (element.type === "Accepted") {
        await answerToAccepted(element);
        // answer to Accepted message in separate function
    }
    // below is option 7
    if (element.type === "Ack") {
        await processAck(element);
        // remove element from outbox for specific sender, since it's fine
    } else {
        await sendAck(element);
    }
    localStorage.setItem(key, JSON.stringify(data));
    return true;
}

async function sendAck(element) {
    const key = getKeyFromElement(element);
    const inbox = localStorage.getItem("inbox");
    let dataToSend = {
        "@context": [
            "https://www.w3.org/ns/activitystreams",
            {
                paxos: "http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#"
            },
        ],
        "@id": element.id,
        "@type": "Object",
        object: {
            "@type": "paxos:Ack",
            "paxos:instance": element.instance,
            "paxos:round": element.round,
            "paxos:proposer": element.proposer,
            "paxos:acceptors": element.acceptors,
            "paxos:startTime": element.startTime,
            "paxos:from": localStorage.getItem("inbox"),
            "paxos:ackKey": `${inbox}|${key}|${element.type}`,
        },
    };
    await sendElement({
        data: dataToSend,
        url: element.from
    });
}

let outbox = {};

function getKeyFromElement(element) {
    if (element["id"] === undefined) {
        element.id = element.name;
    }
    return `${element.id}|${element.instance}`;
}

/*
 * This element should contain the following things:
 */
export async function sendPrepare(element) {
    element.id = element.name;
    const key = getKeyFromElement(element);
    let data = JSON.parse(localStorage.getItem(key)) || {
        lastPromised: -Infinity
    };
    if (Number(data.lastPromised) < Number(element.round)) {
        let dataToSend = {
            "@context": [
                "https://www.w3.org/ns/activitystreams",
                {
                    paxos: "http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#"
                },
            ],
            "@id": element.id,
            "@type": "Object",
            object: {
                "@type": "paxos:Prepare",
                "paxos:instance": element.instance,
                "paxos:round": element.round,
                "paxos:proposer": element.inbox,
                "paxos:acceptors": element.inboxArray,
                "paxos:startTime": new Date(),
                "paxos:from": localStorage.getItem("inbox"),
            },
        };
        data.lastPromised = element.round;
        data.lastAction = "Prepare";
        data.proposer = element.inbox;
        data.acceptors = element.inboxArray;
        localStorage.setItem(key, JSON.stringify(data));
        for (const acceptorUrl of element.inboxArray) {
            outbox[`${acceptorUrl}|${key}|${data.lastAction}`] = {
                data: dataToSend,
                url: acceptorUrl
            };
        }
        return true;
    }
    return false;
}
export async function answerToPrepare(element) {
    const key = getKeyFromElement(element);
    let data = JSON.parse(localStorage.getItem(key)) || {
        lastPromised: -Infinity
    };
    if (Number(data.lastPromised) <= Number(element.round)) {
        console.debug(`Sending promise back to ${JSON.stringify(element)}`);
        let dataToSend = {
            "@context": [
                "https://www.w3.org/ns/activitystreams",
                {
                    paxos: "http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#"
                },
            ],
            "@id": element.id,
            "@type": "Object",
            object: {
                "@type": "paxos:Promise",
                "paxos:instance": element.instance,
                "paxos:round": element.round,
                "paxos:proposer": element.proposer,
                "paxos:acceptors": element.acceptors,
                "paxos:startTime": element.startTime,
                "paxos:from": localStorage.getItem("inbox"),
            },
        };
        data.lastPromised = element.round;
        data.lastAction = "Promise";
        data.proposer = element.proposer;
        data.acceptors = element.acceptors;
        outbox[`${element.proposer}|${key}|${data.lastAction}`] = {
            data: dataToSend,
            url: element.proposer
        };
        localStorage.setItem(key, JSON.stringify(data));
    }
    await deleteInboxElem(element.url);
}
export async function answerToPromise(element) {
    const key = getKeyFromElement(element);
    let data = JSON.parse(localStorage.getItem(key)) || {
        lastPromised: -Infinity
    };
    const haveAcceptors = data["incomingPromise"] || [];
    haveAcceptors.push(element.from);
    data["incomingPromise"] = haveAcceptors;
    let neededAcceptors = (data || {
        acceptors: []
    })["acceptors"] || [];
    let acceptAllowed = neededAcceptors.every((elem) => haveAcceptors.includes(elem));
    if (acceptAllowed) {
        console.debug(`Sending accept back to ${JSON.stringify(element)}`);
        let value = localStorage.getItem(`${key}|value to accept`);
        data.lastPromised = element.round;
        data.lastAction = "Accept";
        let dataToSend = {
            "@context": [
                "https://www.w3.org/ns/activitystreams",
                {
                    paxos: "http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#"
                },
            ],
            "@id": element.id,
            "@type": "Object",
            object: {
                "@type": "paxos:Accept",
                "paxos:instance": element.instance,
                "paxos:round": element.round,
                "paxos:value": value,
                "paxos:proposer": element.proposer,
                "paxos:acceptors": element.acceptors,
                "paxos:startTime": element.startTime,
                "paxos:from": localStorage.getItem("inbox"),
            },
        };
        console.debug("OUTBOX ELEMENT", dataToSend);
        for (const acceptorUrl of element.acceptors) {
            outbox[`${acceptorUrl}|${key}|${data.lastAction}`] = {
                data: dataToSend,
                url: acceptorUrl
            };
        }
    }
    localStorage.setItem(key, JSON.stringify(data));
    await deleteInboxElem(element.url);
}
export async function processAccept(element) {
    console.debug("processing accept", element);
    const key = "awaitingAccepts";
    let awaitingAccepts = JSON.parse(localStorage.getItem(key)) || {};
    awaitingAccepts[getKeyFromElement(element)] = element;
    localStorage.setItem(key, JSON.stringify(awaitingAccepts));
    await deleteInboxElem(element.url);
}
export async function createAccepted(element, accepted) {
    console.debug("CREATED ACCEPTED MESSAGE WITH VALUE", element.value);
    let key = getKeyFromElement(element);
    let data = JSON.parse(localStorage.getItem(key)) || {
        lastPromised: -Infinity
    };
    data.lastPromised = element.round;
    data.lastAction = "Accepted";
    localStorage.setItem(key, JSON.stringify(data));
    let dataToSend = {
        "@context": [
            "https://www.w3.org/ns/activitystreams",
            {
                paxos: "http://www.semanticweb.org/jan-pieter/ontologies/2023/2/paxos-ontology#"
            },
        ],
        "@id": element.id,
        "@type": "Object",
        object: {
            "@type": "paxos:Accepted",
            "paxos:instance": element.instance,
            "paxos:round": element.round,
            "paxos:value": element.value,
            "paxos:acceptedStatus": accepted,
            "paxos:proposer": element.proposer,
            "paxos:acceptors": element.acceptors,
            "paxos:startTime": element.startTime,
            "paxos:from": localStorage.getItem("inbox"),
        },
    };
    for (const acceptorUrl of element.acceptors) {
        outbox[`${acceptorUrl}|${key}|${data.lastAction}`] = {
            data: dataToSend,
            url: acceptorUrl
        };
    }
    outbox[`${element.proposer}|${key}|${data.lastAction}`] = {
        data: dataToSend,
        url: element.proposer
    };

    // remove element from awaiting accepts
    key = "awaitingAccepts";
    let awaitingAccepts = JSON.parse(localStorage.getItem(key)) || {};
    delete awaitingAccepts[getKeyFromElement(element)];
    localStorage.setItem(key, JSON.stringify(awaitingAccepts));
}
export async function answerToAccepted(element) {
    const key = `${element.id}|${element.instance}|accepted`;
    let acceptedData = JSON.parse(localStorage.getItem(key)) || {};
    let data = JSON.parse(localStorage.getItem(`${element.id}|${element.instance}`)) || {
        lastPromised: -Infinity
    };
    data.incomingAccepted = data.incomingAccepted || [];
    acceptedData.agreeingAcceptors = acceptedData.agreeingAcceptors || [];
    acceptedData.disagreeingAcceptors = acceptedData.disagreeingAcceptors || [];
    acceptedData.agreedValue = acceptedData.agreedValue || element.value;
    if (element.accepted && element.value === acceptedData.agreedValue) {
        acceptedData.agreeingAcceptors.push(element.from);
        acceptedData.agreedValue = element.value;
    } else {
        acceptedData.disagreeingAcceptors.push(element.from);
        acceptedData.status = "Failed";
    }
    if (
        acceptedData.disagreeingAcceptors.length === 0 &&
        data.acceptors?.every((elem) => acceptedData.agreeingAcceptors.includes(elem))
    ) {
        acceptedData.status = "Success";
    }
    acceptedData.disagreeingAcceptors = [...new Set(acceptedData.disagreeingAcceptors)];
    acceptedData.agreeingAcceptors = [...new Set(acceptedData.agreeingAcceptors)];
    localStorage.setItem(key, JSON.stringify(acceptedData));
    await deleteInboxElem(element.url);
}
export async function processAck(element) {
    delete outbox[element.ackKey];
    await deleteInboxElem(element.url);
}

let inboxCronStarted = false;
let inboxJob;

/**
 * Do for inbox checking, every 10 seconds
 */
export function inboxCron() {
    if (!inboxCronStarted) {
        console.debug("INBOX CRON STARTED");
        // TODO: fix cronjob timing
        inboxJob = cron.job(
            "*/5 * * * * *",
            async function() {
                    await checkInboxElements();
                },
                null,
                true,
                "Europe/Brussels"
        );
        inboxJob.start();
        inboxCronStarted = true;
    }
}

async function checkInboxElements() {
    console.debug("Checking inbox elements");
    const inboxUrl = localStorage.getItem("inbox");
    if (inboxUrl === undefined) {
        console.debug("Can't check inbox, localstorage item not set");
    } else {
        const inboxElements = await getAllInboxElements(inboxUrl);
        for (const inboxElement of inboxElements) {
            await processInboxElem(inboxElement);
        }
    }
    // TODO: fix inbox checking
}

let outboxCronStarted = false;
let outboxJob;
/**
 * Do for outbox checking, every 1 minute
 */
export function outboxCron() {
    if (!outboxCronStarted) {
        console.debug("OUTBOX CRON STARTED");
        // TODO: fix cronjob timing
        outboxJob = cron.job(
            "*/10 * * * * *",
            async function() {
                    await sendOutboxElements();
                },
                null,
                true,
                "Europe/Brussels"
        );
        outboxJob.start();
        outboxCronStarted = true;
    }
}

async function sendElement(element) {
    fetch(element.url, {
        method: "POST",
        cors: "cors",
        headers: {
            "Content-Type": "application/ld+json",
        },
        body: JSON.stringify(element.data),
    });
}

async function sendOutboxElements() {
    console.debug("Sending all outbox elements");
    console.debug(`Outbox is`);
    console.debug(outbox);
    for (const key in outbox) {
        await sendElement(outbox[key]);
    }
}
