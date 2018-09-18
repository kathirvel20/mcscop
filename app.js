// cop fqdn.  Don't include http, https, etc.
const url = 'www.ironrain.org'

// enable content security policy (this requires url to be set!)
const cspEnabled = false;

const Ajv = require('ajv');
const validators = require('./validators.js');
const express = require('express');
const app = express();
const async = require('async');
const bcrypt = require('bcrypt-nodejs');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http').Server(app);
const session = require('express-session');
const MongoClient = require('mongodb').MongoClient;
const MongoStore = require('connect-mongo')(session);
const multer = require('multer');
const ObjectID = require('mongodb').ObjectID;
const path = require('path');
const ShareDB = require('sharedb');
const richText = require('rich-text');
const rooms = new Map();
const upload = multer({dest: './temp_uploads'});
const WebSocketJSONStream = require('websocket-json-stream');
const xssFilters = require('xss-filters');
const wss = require('ws');
const ws = new wss.Server({server:http});

const cop_permissions = ['all', 'manage_missions', 'delete_missions', 'manage_users', 'manage_roles'];
const mission_permissions = ['all', 'manage_users', 'modify_diagram', 'create_events', 'delete_events', 'modify_notes', 'create_opnotes', 'delete_opnotes', 'modify_files', 'api_access'];

app.set('view engine', 'pug');
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'ProtextTheCybxers',
    name: 'session',
    saveUninitialized: true,
    resave: true,
    store: new MongoStore({
        url: 'mongodb://localhost/mcscop',
        host: 'localhost',
        collection: 'sessions',
        autoReconnect: true,
        clear_interval: 3600
    })
}));

if (cspEnabled) {
    app.use(function(req, res, next) {
        res.setHeader("Content-Security-Policy", "connect-src 'self' wss://" + url + " ws://" + url + "; worker-src 'self' https://" + url + " blob:; default-src 'unsafe-inline' 'unsafe-eval' 'self'; img-src 'self' data: blob:;");
        return next();
    });
}

// setup ajv json validation
const ajv = new Ajv();

// connect to mongo
var mdb;
MongoClient.connect('mongodb://localhost/mcscop', {
        reconnectTries: Number.MAX_VALUE,
        autoReconnect: true,
        wtimeout: 5000 
    }, function(err, database) {
    if (err) throw err;
    database.on('close', function() {
        console.log('Connection to database closed. Error?');
        ws.clients.forEach(function each(socket) {
            socket.close();
        });
    });
    mdb = database;
});

const sdb = require('sharedb-mongo')('mongodb://localhost:27017/mcscop');
ShareDB.types.register(richText.type);
const backend = new ShareDB({sdb: sdb, disableDocAction: true, disableSpaceDelimitedActions: true});

backend.use('receive', function(r,c) {
//    console.log(r);
    c();
});

Array.prototype.move = function (old_index, new_index) {
    if (new_index >= this.length) {
        var k = new_index - this.length;
        while ((k--) + 1) {
            this.push(undefined);
        }
    }
    this.splice(new_index, 0, this.splice(old_index, 1)[0]);
    return this;
};

function dynamicSort(property) {
    var sortOrder = 1;
    if(property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a,b) {
        var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
}

function sendToRoom(room, msg, selfSocket, roleFilter) {
    if (!selfSocket)
        selfSocket = null;
    if (rooms.get(room)) {
        rooms.get(room).forEach((socket) => {
            if (socket && socket.readyState === socket.OPEN) {
                if (roleFilter && socket.sub_roles.indexOf(roleFilter) !== -1 && socket !== selfSocket) {
                    socket.send(msg); 
                } else if (socket !== selfSocket) {
                    socket.send(msg);
                }
            }
        });
    }
}

function hasPermission(permissions, permission) {
    if (permissions && (permissions.indexOf(permission) > -1 || permissions.indexOf('all') > -1))
        return true;
    return false;
}

function getDir(dir, mission_id, cb) {
    var resp = new Array();
    if (dir === path.join(__dirname + '/mission-files/mission-' + mission_id)) {
        fs.stat(dir, function (err, s) {
            if (err == null) {
            } else if (err.code == 'ENOENT') {
                fs.mkdir(dir,function(err){
                    if(err)
                        console.log(err);
               });
            } else {
                console.log(err);
            }
        });
        resp.push({
            "id": '/',
            "text": '/',
            "icon" : 'jstree-custom-folder',
            "state": {
                "opened": true,
                "disabled": false,
                "selected": false
            },
            "li_attr": {
                "base": '#',
                "isLeaf": false
            },
            "a_attr": {
                "class": 'droppable'
            },
            "children": null
        });
    }
    fs.readdir(dir, function(err, list) {
        if (list) {
            var children = new Array();
            list.sort(function(a, b) {
                return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
            }).forEach(function(file, key) {
                children.push(processNode(dir, mission_id, file));
            });
            if (dir === path.join(__dirname + '/mission-files/mission-' + mission_id)) {
                resp[0].children = children;
                cb(resp);
            } else
                cb(children);
        } else {
            cb([]);
        }
    });
}

function processNode(dir, mission_id, f) {
    var s = fs.statSync(path.join(dir, f));
    var base = path.join(dir, f);
    var rel = path.relative(path.join(__dirname, '/mission-files/mission-' + mission_id), base);
    return {
        "id": rel,
        "text": f,
        "icon" : s.isDirectory() ? 'jstree-custom-folder' : 'jstree-custom-file',
        "state": {
            "opened": false,
            "disabled": false,
            "selected": false
        },
        "li_attr": {
            "base": rel,
            "isLeaf": !s.isDirectory()
        },
        "a_attr": {
            "class": (s.isDirectory() ? 'droppable' : '')
        },
        "children": s.isDirectory()
    };
}

function insertLogEvent(socket, message, channel) {
    if (!channel || channel === '')
        channel = 'log';
    var timestamp = (new Date).getTime();
    var log = { mission_id: ObjectID(socket.mission_id), user_id: ObjectID(socket.user_id), channel: channel, text: message, timestamp: timestamp, deleted: false };
    mdb.collection('chats').insertOne(log, function (err, result) {
        if (!err) {
            log.username = socket.username;
            sendToRoom(socket.room, JSON.stringify({ act: 'chat', arg: [ log ] }));
        } else
            console.log(err);
    });
}

ws.on('connection', function(socket, req) {
    socket.loggedin = false;
    socket.session = '';
    socket.mission_id = 0;
    var s = req.headers.cookie.split('session=s%3A')[1].split('.')[0];
    if (s) {
        socket.session = s;
        mdb.collection('sessions').findOne({ _id: s }, function(err, row) {
            if (row) {
                try {
                    var data = JSON.parse(row.session);
                    socket.loggedin = data.loggedin;
                    socket.user_id = data.user_id;
                    socket.username = data.username;
                    socket.role = data.role;
                    socket.cop_permissions = data.cop_permissions;
                    socket.mission_permissions = data.mission_permissions;
                    socket.mission_role = data.mission_role;
                    socket.sub_roles = data.sub_roles;
                    setupSocket(socket);
                } catch (e) {
                    console.log(e);
                }
            } else if (err)
                console.log(err);
        });
    }
    socket.isAlive = true;
});

// make sure sockets are still alive
const pingInterval = setInterval(function ping() {
    ws.clients.forEach(function each(socket) {
        if (socket.isAlive === false)
            return socket.terminate();
        socket.isAlive = false;
        socket.ping(function() {});
    });
}, 30000);

async function getObjects(socket) {
    try {
        res = await mdb.collection('objects').find({ mission_id: ObjectID(socket.mission_id), deleted: { $ne: true } }).sort({ z: 1 }).toArray();
        return res;
    } catch (err) {
        console.log(err);
        return [];
    }
}


async function getRoles(socket) {
    try {
        return await mdb.collection('roles').find({ deleted: { $ne: true }}).toArray();
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function getUsers(socket) {
    try {
        return await mdb.collection('users').find({ deleted: { $ne: true } }, { username: 1 }).toArray();
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function getNotes(socket) {
    try {
        var resp = new Array();
        var rows = await mdb.collection('notes').find({ $and: [ { mission_id: ObjectID(socket.mission_id) }, { deleted: { $ne: true } } ] }).sort({ name : 1 }).toArray();
        for (var i = 0; i < rows.length; i++) {
            resp.push({
                "id": rows[i]._id,
                "text": rows[i].name,
                "icon" : 'jstree-custom-file',
                "state": {
                    "opened": false,
                    "disabled": false,
                    "selected": false
                },
                "li_attr": {
                    "base": '#',
                    "isLeaf": true
                },
                "children": false
            });
        }
        return resp;
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function getUserSettings(socket) {
    try {
        return await mdb.collection('missions').aggregate([
            {
                $match: { _id: ObjectID(socket.mission_id), deleted: { $ne: true } }
            },{
                $unwind: '$mission_users'
            },{
                $lookup: {
                    from: 'users',
                    localField: 'mission_users.user_id',
                    foreignField: '_id',
                    as: 'user'
                }
            },{
                $project: {
                    _id: '$mission_users._id',
                    user_id: '$mission_users.user_id',
                    username: '$user.username',
                    permissions: '$mission_users.permissions',
                    role: '$mission_users.role'
                }
            }
        ]).toArray();
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function getEvents(socket) {
    try {
        return await mdb.collection('events').aggregate([
            {
                $match: { mission_id: ObjectID(socket.mission_id), deleted: { $ne: true }}
            },{
                $sort: { event_time: 1 }
            },{
                $lookup: {
                    from: 'users',
                    localField: 'user_id',
                    foreignField: '_id',
                    as: 'username'
                }
            },{
                $project: {
                    _id: 1,
                    mission_id: 1,
                    event_time: 1,
                    discovery_time: 1,
                    event_type: 1,
                    source_object: 1,
                    dest_object: 1,
                    source_port: 1,
                    dest_port: 1,
                    short_desc: 1,
                    assignment: 1,
                    user_id: 1,
                    username: '$username.username'
                }
            }
        ]).toArray();
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function getOpnotes(socket) {
    try {
        return await mdb.collection('opnotes').aggregate([
            {
                $match: { mission_id: ObjectID(socket.mission_id), deleted: { $ne: true }}
            },{
                $sort: { event_time: 1 }
            },{
                $lookup: {
                    from: 'users',
                    localField: 'user_id',
                    foreignField: '_id',
                    as: 'username'
                },
            },{
                $project: {
                    _id: 1,
                    event_id: 1,
                    mission_id: 1,
                    evt: 1,
                    event_time: 1,
                    source_object: 1,
                    tool: 1,
                    action: 1,
                    user_id: 1,
                    username: '$username.username'
                }
            }
        ]).toArray();
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function getChats(socket) {
    try {
        var res = [];
        var channels = await mdb.collection('chats').distinct('channel');
        for (var i = 0; i < channels.length; i++) {
            var rows = await mdb.collection('chats').aggregate([
                {
                    $match: { mission_id: ObjectID(socket.mission_id), channel: channels[i], deleted: { $ne: true } }
                },{
                    $sort: { timestamp: -1 }
                },{
                    $limit: 50
                },{
                    $sort: { timestamp: 1 }
                },{
                    $lookup: {
                        from: 'users',
                        localField: 'user_id',
                        foreignField: '_id',
                        as: 'username'
                    }
                },{
                    $project: {
                        _id: 1,
                        user_id: 1,
                        channel: 1,
                        text: 1,
                        timestamp: 1,
                        username: '$username.username'
                    }
                }]).toArray();
            if (rows) {
                if (rows.length == 50) {
                    rows[0].more = 1;
                }
                res = res.concat(rows);
            }
        }
        return res;
    } catch (err) {
        console.log(err);
        return [];
    }
}

async function setupSocket(socket) {
    if (!socket.loggedin) {
        socket.close();
        return;
    }

    socket.on('pong', function () {
        socket.isAlive = true;
    });

    socket.on('message', async function(msg, flags) {
        try {
            msg = JSON.parse(msg);
        } catch (e) {
            return;
        }
        if (msg.act && ((msg.act === 'stream' || msg.act === 'join') || (socket.mission_id && ObjectID.isValid(socket.mission_id) && socket.user_id && ObjectID.isValid(socket.user_id))) && socket.loggedin) {
            switch (msg.act) {
                case 'stream':
                    var stream = new WebSocketJSONStream(socket);
                    socket.type = 'sharedb';
                    backend.listen(stream);
                    break;

                case 'join':
                    //TODO permissions
                    socket.room = msg.arg.mission_id;
                    socket.mission_id = msg.arg.mission_id;
                    if (!rooms.get(msg.arg.mission_id))
                        rooms.set(msg.arg.mission_id, new Set());
                    rooms.get(msg.arg.mission_id).add(socket);
                    socket.type = 'diagram';

                    var resp = {};

                    resp.users = await getUsers(socket);
                    resp.roles = await getRoles(socket);
                    resp.objects = await getObjects(socket);
                    resp.events = await getEvents(socket);
                    resp.opnotes = await getOpnotes(socket);
                    resp.userSettings = await getUserSettings(socket);
                    resp.notes = await getNotes(socket);
                    resp.chats = await getChats(socket);

                    socket.send(JSON.stringify({ act:'join', arg: resp }));

                    break;

                // ------------------------- CHATS -------------------------
                case 'insert_chat':
                    if (ajv.validate(validators.insert_chat, msg.arg)) {
                        msg.arg.username = socket.username;
                        msg.arg.user_id = socket.user_id;
                        msg.arg.text = xssFilters.inHTMLData(msg.arg.text);
                        msg.arg.timestamp = (new Date).getTime();

                        var chat = { mission_id: ObjectID(socket.mission_id), user_id: ObjectID(socket.user_id), channel: msg.arg.channel, text: msg.arg.text, timestamp: msg.arg.timestamp, deleted: false };
                        mdb.collection('chats').insertOne(chat, function (err, result) {
                            if (!err) {
                                sendToRoom(socket.room, JSON.stringify({ act:'chat', arg: [msg.arg] }));
                            } else
                                console.log(err);
                        });
                    }
                    break;

                case 'get_old_chats':
                    if (!msg.arg.start_from || isNaN(msg.arg.start_from) || !msg.arg.channel)
                        break;

                    mdb.collection('chats').aggregate([
                        {
                            $match: { mission_id: ObjectID(socket.mission_id), channel: msg.arg.channel, timestamp: { $lt: parseInt(msg.arg.start_from) }, deleted: { $ne: true } }
                        },{
                            $sort: { timestamp: -1 }
                        },{
                            $limit: 50
                        },{
                            $lookup: {
                                from: 'users',
                                localField: 'user_id',
                                foreignField: '_id',
                                as: 'username'
                            }
                        },{
                            $project: {
                                _id: 1,
                                user_id: 1,
                                channel: 1,
                                text: 1,
                                timestamp: 1,
                                prepend: 'true',
                                username: '$username.username'
                            }
                    }]).toArray(function(err, rows) {
                        if (rows) {
                            if (rows.length == 50)
                                if (msg.arg.start_from !== undefined && !isNaN(msg.arg.start_from))
                                    rows[49].more = 1;
                                else
                                    rows[0].more = 1;
                            socket.send(JSON.stringify({ act:'bulk_chat', arg: rows }));
                        } else {
                            socket.send(JSON.stringify({ act: 'bulk_chat', arg: [] }));
                            if (err)
                                console.log(err);
                        }
                    });
                    break;

               case 'insert_user_setting':
                    var user = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'manage_users') && ajv.validate(validators.insert_user_setting, user)) {
                        var new_perms = [];

                        if (user.permissions) {
                            for (var i = 0; i < user.permissions.length; i++) {
                                if (mission_permissions.indexOf(user.permissions[i]) > -1)
                                    new_perms.push(user.permissions[i]);
                            }
                        }

                        var new_values = { $push: { mission_users: { _id: ObjectID(null), user_id: ObjectID(user.user_id), permissions: new_perms, role: null } } };
                        
                        if (user.role && ObjectID.isValid(user.role))
                            new_values.$push.mission_users.role = ObjectID(user.role);

                        mdb.collection('missions').count({ _id: ObjectID(socket.mission_id), 'mission_users.user_id': ObjectID(user.user_id) }, function(err, count) {
                            if (!err) {
                                // don't let the user make the same user setting over again
                                if (count === 0) {
                                    mdb.collection('missions').updateOne({ _id: ObjectID(socket.mission_id) }, new_values, function (err, result) {
                                        if (!err) {
                                            socket.send(JSON.stringify({act: 'insert_user_setting', arg: user}));
                                            insertLogEvent(socket, 'Inserted user setting ID: ' + user.user_id + '.');
                                        } else
                                            console.log(err);
                                    });
                                }
                            } else
                                console.log(err);
                        });
                    } else {
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    }
                    break;

                case 'update_user_setting':
                    var user = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'manage_users') && ajv.validate(validators.update_user_setting, user)) {
                        var new_perms = [];

                        user.permissions = xssFilters.inHTMLData(user.permissions);

                        if (user.permissions) {
                            user.permissions = user.permissions.split(',');
                            for (var i = 0; i < user.permissions.length; i++) {
                                if (mission_permissions.indexOf(user.permissions[i]) > -1)
                                    new_perms.push(user.permissions[i]);
                            }
                        }

                        var new_values = { $set: { 'mission_users.$.permissions': new_perms, 'mission_users.$.role': null }  };

                        if (user.role && ObjectID.isValid(user.role))
                            new_values.$set['mission_users.$.role'] = ObjectID(user.role);

                        mdb.collection('missions').updateOne({ _id: ObjectID(socket.mission_id), 'mission_users.user_id': ObjectID(user.user_id) }, new_values, function (err, result) {
                            if (!err) {
                                socket.send(JSON.stringify({act: 'update_user_setting', arg: user}));
                                insertLogEvent(socket, 'Modified user setting ID: ' + user.user_id + '.');
                            } else
                                console.log(err);
                        });
                    } else {
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    }
                    break;

                case 'delete_user_setting':
                    var user = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'manage_users') && user._id && ObjectID.isValid(user._id)) {

                        mdb.collection('missions').findOneAndUpdate({ _id: ObjectID(socket.mission_id) }, { $pull: { mission_users: { _id: ObjectID(user._id) } } }, function (err, result) {
                            if (!err) {
                                sendToRoom(socket.room, JSON.stringify({act: 'delete_user_setting', arg: user}));
                                insertLogEvent(socket, 'Deleted user setting ID: ' + user._id + '.');
                            } else
                                console.log(err);
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                // ------------------------- NOTES -------------------------
               case 'insert_note':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'edit_notes') && ajv.validate(validators.insert_note, e)) {

                        e.name = xssFilters.inHTMLData(e.name);
                        var note = { mission_id: ObjectID(socket.mission_id), name: e.name, deleted: false };

                        mdb.collection('notes').insertOne(note, function (err, result) {
                            if (!err) {
                                insertLogEvent(socket, 'Created note: ' + e.name + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'insert_note', arg: {
                                    "id": note._id,
                                    "text": e.name,
                                    "icon" : 'jstree-custom-file',
                                    "state": {
                                        "opened": false,
                                        "disabled": false,
                                        "selected": false
                                    },
                                    "li_attr": {
                                        "base": '#',
                                        "isLeaf": true
                                    },
                                    "children": false
                                }}));
                            } else
                                console.log(err);
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                case 'rename_note':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'edit_notes') && ajv.validate(validators.rename_note, e)) {

                        e.name = xssFilters.inHTMLData(e.name);
                        var new_values = { $set: { name: e.name } };

                        mdb.collection('notes').updateOne({ _id: ObjectID(e.id) }, new_values, function (err, result) {
                            if (!err) {
                                insertLogEvent(socket, 'Renamed note: ' + e.id + ' to: ' + e.name + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'rename_note', arg: {
                                    id: e.id,
                                    name: e.name
                                }}));
                            } else
                                console.log(err);
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                case 'delete_note':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'edit_notes') && e.id && ObjectID.isValid(e.id)) {

                        mdb.collection('notes').updateOne({ _id: ObjectID(e.id) }, { $set: { deleted: true } }, function (err, result) {
                            if (!err) {
                                insertLogEvent(socket, 'Deleted note: ' + e.id + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'delete_note', arg: e}));
                            } else
                                console.log(err);
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                // ------------------------- EVENTS -------------------------
               case 'update_event':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'modify_events') && ajv.validate(validators.update_event, e)) {

                        e.event_type = xssFilters.inHTMLData(e.event_type);
                        e.short_desc = xssFilters.inHTMLData(e.short_desc);
                        e.source_port = xssFilters.inHTMLData(e.source_port);
                        e.dest_port = xssFilters.inHTMLData(e.dest_port);

                        var new_values = { $set: { event_time: e.event_time, discovery_time: e.discovery_time, source_object: null, source_port: e.source_port, dest_object: null, dest_port: e.dest_port, event_type: e.event_type, short_desc: e.short_desc, assignment: null} };

                        if (e.source_object && ObjectID.isValid(e.source_object))
                            new_values.$set.source_object = ObjectID(e.source_object);
                        if (e.dest_object && ObjectID.isValid(e.dest_object))
                            new_values.$set.dest_object = ObjectID(e.dest_object);
                        if (e.assignment && ObjectID.isValid(e.assignment))
                            new_values.$set.assignment = ObjectID(e.assignment);
    
                        mdb.collection('events').updateOne({ _id: ObjectID(e._id) }, new_values, function (err, result) {
                            if (!err) {
                                insertLogEvent(socket, 'Modified event: ' + e.event_type + ' ID: ' + e._id + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'update_event', arg: e}), socket);
                            } else
                                console.log(err);
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                case 'insert_event':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'create_events') && ajv.validate(validators.insert_event, e)) {
                        e.event_type = xssFilters.inHTMLData(e.event_type);
                        e.short_desc = xssFilters.inHTMLData(e.short_desc);
                        e.source_port = xssFilters.inHTMLData(e.source_port);
                        e.dest_port = xssFilters.inHTMLData(e.dest_port);
                        e.user_id = socket.user_id;
                        e.username = socket.username;

                        var evt = { mission_id: ObjectID(socket.mission_id), event_time: e.event_time, discovery_time: e.discovery_time, source_object: null, source_port: e.source_port, dest_object: null, dest_port: e.dest_port, event_type: e.event_type, short_desc: e.short_desc, user_id: ObjectID(socket.user_id), deleted: false };

                        if (e.source_object && ObjectID.isValid(e.source_object))
                            evt.source_object = ObjectID(e.source_object);
                        if (e.dest_object && ObjectID.isValid(e.dest_object))
                            evt.dest_object = ObjectID(e.dest_object);
                        if (e.assignment && ObjectID.isValid(e.assignment))
                            evt.assignment = ObjectID(e.assignment);

                        mdb.collection('events').insertOne(evt, function (err, result) {
                            if (!err) {
                                e._id = evt._id;
                                insertLogEvent(socket, 'Created event: ' + e.event_type + ' ID: ' + e._id + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'insert_event', arg: e}));
                            } else
                                console.log(err);
                        });
                    } else {
                        console.log(ajv.errors);
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    }
                    break;

                case 'delete_event':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'delete_events') && e._id && ObjectID.isValid(e._id)) {

                        mdb.collection('events').updateOne({ _id: ObjectID(e._id) }, { $set: { deleted: true } }, function (err, result) {
                            if (!err) {
                                insertLogEvent(socket, 'Deleted event ID: ' + e._id + '.');
                                sendToRoom(socket.room, JSON.stringify({ act: 'delete_event', arg: e }), socket);
                            } else
                                console.log(err);
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                // ------------------------- OPNOTES -------------------------
               case 'update_opnote':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'create_opnotes') && ajv.validate(validators.update_opnote, e)) {

                        e.source_object = xssFilters.inHTMLData(e.source_object);
                        e.tool = xssFilters.inHTMLData(e.tool);
                        e.action = xssFilters.inHTMLData(e.action);

                        var new_values = { $set: { event_time: e.event_time, event_id: null, source_object: e.source_object, tool: e.tool, action: e.action } };

                        if (e.event_id && ObjectID.isValid(e.event_id))
                            new_values.$set.event_id = ObjectID(e.event_id);

                        mdb.collection('opnotes').updateOne({ _id: ObjectID(e._id) }, new_values, function (err, result) {
                            if (!err) {
                                e.username = socket.username;
                                insertLogEvent(socket, 'Modified opnote: ' + e.action + ' ID: ' + e._id + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'update_opnote', arg: e}), socket, socket.role);
                            } else
                                console.log(err);
                        });
                    } else {
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    }
                    break;

                case 'insert_opnote':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'create_opnotes') && ajv.validate(validators.insert_opnote, e)) {

                        e.user_id = socket.user_id;
                        e.source_object = xssFilters.inHTMLData(e.source_object);
                        e.tool = xssFilters.inHTMLData(e.tool);
                        e.action = xssFilters.inHTMLData(e.action);

                        var opnote = { mission_id: ObjectID(socket.mission_id), event_id: null, role: socket.mission_role[socket.mission_id], event_time: e.event_time, source_object: e.source_object, tool: e.tool, action: e.action, user_id: ObjectID(e.user_id), deleted: false };

                        if (e.event_id && ObjectID.isValid(e.event_id))
                            e.event_id = ObjectID(e.event_id);

                        mdb.collection('opnotes').insertOne(opnote, function (err, result) {
                            if (!err) {
                                e._id = opnote._id;
                                e.user_id = socket.user_id;
                                e.username = socket.username;
                                insertLogEvent(socket, 'Created opnote: ' + e.action + ' ID: ' + e._id + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'insert_opnote', arg: e}), null, socket.role);
                            } else
                                console.log(err);
                        });
                    } else {
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    }
                    break;

                case 'delete_opnote':
                    var e = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'delete_opnotes') && e._id && ObjectID.isValid(e._id)) {
                        mdb.collection('opnotes').updateOne({ _id: ObjectID(e._id) }, { $set: { deleted: true } }, function (err, result) {
                            if (!err) {
                                insertLogEvent(socket, 'Deleted opnote ID: ' + e._id + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'delete_opnote', arg: e}), socket, socket.role);
                            } else
                                console.log(err);
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                // ------------------------- OBJECTS -------------------------
                case 'paste_object':
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'modify_diagram')) {
                        var args = [];
                        async.eachOf(msg.arg, function(o, index, callback) {
                            if (ajv.validate(validators.paste_object, o)) {
                                mdb.collection('objects').findOne({ _id: ObjectID(o._id), type: { $ne: 'link' }, deleted: { $ne: true }}, function(err, row) {
                                    if (row) {
                                        row._id = ObjectID(null);
                                        row.z = o.z;
                                        row.x = o.x;
                                        row.y = o.y;

                                        mdb.collection('objects').insertOne(row, function (err, result) {
                                            if (!err) {
                                                insertLogEvent(socket, 'Created ' + row.type + ': ' + row.name + '.');
                                                args.push(row);
                                                callback();
                                            } else
                                                callback(err);
                                        });
                                    } else {
                                        if (err)
                                            callback(err);
                                    }
                                });
                            }
                        }, function (err) {
                            if (err)
                                console.log(err);
                            else
                                sendToRoom(socket.room, JSON.stringify({ act: 'insert_object', arg: args }));
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                case 'insert_object':
                    var o = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'modify_diagram') && ajv.validate(validators.insert_object, o)) {
                        o.rot = 0;
                        o.scale_x = 1;
                        o.scale_y = 1;
                        if (o.type === 'shape') {
                            o.scale_x = 65;
                            o.scale_y = 65;
                        }
                        o.type = xssFilters.inHTMLData(o.type);
                        o.name = xssFilters.inHTMLData(o.name);
                        o.fill_color = xssFilters.inHTMLData(o.fill_color);
                        o.stroke_color = xssFilters.inHTMLData(o.stroke_color);
                        o.image = xssFilters.inHTMLData(o.image);

                        // get object count for new z
                        mdb.collection('objects').count({ mission_id: ObjectID(socket.mission_id) }, function(err, count) {
                            if (!err) {
                                var new_object;
                                if (o.type === 'icon' || o.type === 'shape')
                                    new_object = { mission_id: ObjectID(socket.mission_id), type: o.type, name: o.name, fill_color: o.fill_color, stroke_color: o.stroke_color, image: o.image, scale_x: o.scale_x, scale_y: o.scale_y, rot: o.rot, x: o.x, y: o.y, z: count, locked: o.locked, deleted: false };
                                else if (o.type === 'link')
                                    new_object = { mission_id: ObjectID(socket.mission_id), type: o.type, name: o.name, stroke_color: o.stroke_color, image: o.image, obj_a: ObjectID(o.obj_a), obj_b: ObjectID(o.obj_b), z: 0, locked:o.locked, deleted: false };
                                // add object to db
                                mdb.collection('objects').insertOne(new_object, function (err, result) {
                                    if (!err) {
                                        // if link, push to back
                                        if (o.type === 'link') {
                                            mdb.collection('objects').find({ $and: [ { mission_id: ObjectID(socket.mission_id) }, { deleted: { $ne: true } } ] }, { _id: 1 }).sort({ z: 1 }).toArray(function(err, rows) {
                                                var zs = rows.map(r => String(r._id));
                                                zs.move(zs.indexOf(String(new_object._id)), 0);
                                                async.forEachOf(zs, function(item, index, callback) {
                                                    var new_values = { $set: { z: index }};
                                                    mdb.collection('objects').updateOne({ _id: ObjectID(item) }, new_values, function (err, result) {
                                                        if (err)
                                                            callback(err);
                                                        else
                                                            callback();
                                                    });
                                                }, function(err) {
                                                    insertLogEvent(socket, 'Created ' + o.type + ': ' + o.name + '.');
                                                    sendToRoom(socket.room, JSON.stringify({ act: 'insert_object', arg: [new_object] }));
                                                });
                                            });
                                        } else {
                                            // push object back to room
                                            insertLogEvent(socket, 'Created ' + o.type + ': ' + o.name + '.');
                                            sendToRoom(socket.room, JSON.stringify({ act: 'insert_object', arg: [new_object] }));
                                        }
                                    } else {
                                        console.log(err);
                                    }
                                });
                            } else {
                                console.log(err);
                            }
                        });
                    } else {
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    }
                    break;

                case 'delete_object':
                    var o = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'modify_diagram') || !o._id || !ObjectID.isValid(o._id)) {
                        var query = { $or: [ { _id: ObjectID(o._id) }, { obj_a: ObjectID(o._id) }, { obj_b: ObjectID(o._id) } ] };
                        mdb.collection('objects').find(query, { _id: 1 }).toArray(function(err, rows) {
                            if (!err) {
                                async.each(rows, function(row, callback) {
                                    mdb.collection('objects').updateOne({ _id: ObjectID(row._id) }, { $set: { deleted: true }}, function (err, result) {
                                        if (!err) {
                                            sendToRoom(socket.room, JSON.stringify({act: 'delete_object', arg:row._id}));
                                        } else
                                            console.log(err);
                                    });
                                }, function(err) {
                                    mdb.collection('objects').find({ $and: [ { mission_id: ObjectID(socket.mission_id) }, { deleted: { $ne: true } } ] }, { _id: 1 }).sort({ z: 1 }).toArray(function(err, rows) {
                                        var zs = rows.map(r => String(r._id));
                                        async.forEachOf(zs, function(item, index, callback) {
                                            var new_values = { $set: { z: index }};
                                            mdb.collection('objects').updateOne({ _id: ObjectID(item) }, new_values, function (err, result) {
                                                if (err)
                                                    callback(err)
                                                else
                                                    callback();
                                            });
                                        });
                                    });
                                });
                            } else {
                                console.log(err);
                            }
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                case 'change_object':
                    var o = msg.arg;
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'modify_diagram') && ajv.validate(validators.change_object, o)) {
                        o.name = xssFilters.inHTMLData(o.name);
                        o.fill_color = xssFilters.inHTMLData(o.fill_color);
                        o.stroke_color = xssFilters.inHTMLData(o.stroke_color);
                        o.image = xssFilters.inHTMLData(o.image);

                        var new_values = { $set: { name: o.name, fill_color: o.fill_color, stroke_color: o.stroke_color, image: o.image, locked: o.locked }};
                        mdb.collection('objects').updateOne({ _id: ObjectID(o._id) }, new_values, function (err, result) {
                            if (!err) {
                                insertLogEvent(socket, 'Modified object: ' + o.name + ' ID: ' + o._id + '.');
                                sendToRoom(socket.room, JSON.stringify({act: 'change_object', arg: msg.arg}));
                            } else {
                                console.log(err);
                            }
                        });
                    } else {
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    }
                    break;

                case 'move_object':
                    if (hasPermission(socket.mission_permissions[socket.mission_id], 'modify_diagram')) {
                        msg.arg.sort(dynamicSort('z'));
                        var args = []; // for x/y moves
                        var args_broadcast = []; // for z moves... to everyone
                        mdb.collection('objects').find({ mission_id: ObjectID(socket.mission_id), deleted: { $ne: true } }, { _id: 1, z: 1, name: 1 }).sort({ z: 1 }).toArray(function(err, rows) {
                            if (rows) {
                                var zs = rows.map(r => String(r._id));
                                async.eachOf(msg.arg, function(o, index, callback) {
                                    if (ajv.validate(validators.move_object, o)) {
                                        // move objects (z-axis)
                                        if (o.z !== zs.indexOf(o._id)) {
                                            o.z = Math.floor(o.z);
                                            zs.move(zs.indexOf(String(o._id)), o.z);
                                            async.forEachOf(zs, function(item, index, callback) {
                                                var new_values = { $set: { z: index }};
                                                mdb.collection('objects').updateOne({ _id: ObjectID(item) }, new_values, function (err, result) {
                                                    if (err)
                                                        callback(err);
                                                    else {
                                                        if (item === o._id)
                                                            args_broadcast.push(o);
                                                        callback();
                                                    }
                                                });
                                            }, function(err) { // async callback
                                                if (err)
                                                    callback(err);
                                                else
                                                    callback();
                                            });
                                        // move objects (x/y axis)
                                        } else {
                                            o.x = Math.round(o.x);
                                            o.y = Math.round(o.y);
                                            var new_values = { $set: { x: o.x, y: o.y, scale_x: o.scale_x, scale_y: o.scale_y, rot: o.rot }};
                                            mdb.collection('objects').updateOne({ _id: ObjectID(o._id) }, new_values, function (err, result) {
                                                if (err)
                                                    callback(err)
                                                else
                                                    args.push(o);
                                                    callback();
                                            });
                                        }
                                    }
                                }, function (err) { // async callback
                                    if (err)
                                        console.log(err);
                                    else {
                                        sendToRoom(socket.room, JSON.stringify({act: 'move_object', arg: args.concat(args_broadcast)}), socket);
                                        socket.send(JSON.stringify({act: 'move_object', arg: args_broadcast}));
                                    }
                                });
                            } else { // no rows or error
                                if (err)
                                    console.log(err);
                            }
                        });
                    } else
                        socket.send(JSON.stringify({ act: 'error', arg: { text: 'Error: Permission denied. Changes not saved.' } }));
                    break;

                case 'change_link':
                    var o = msg.arg;
                    if (o.type !== undefined && o.type === 'link') {
                    }
                    break;

            }
            if (msg.msgId !== undefined) {
                socket.send(JSON.stringify({act: 'ack', arg: msg.msgId}));
            }
        }
    });
}

app.get('/', function (req, res) {
    if (req.session.loggedin) {
            res.render('index', { title: 'MCSCOP', permissions: req.session.cop_permissions});
    } else {
       res.redirect('login');
    }
});

app.get('/logout', function (req, res) {
    req.session.destroy();
    res.redirect('login');
});

app.get('/getroles', function (req, res) {
    if (!req.session.loggedin) {
        res.end('ERR1');
        return;
    }
    var sel = '<select class="tableselect">';
    mdb.collection('roles').find({ deleted: { $ne: true } }, { password: 0 }).toArray(function(err, rows) {
        if (rows) {
            for (var i = 0; i < rows.length; i++)
                sel += '<option value="' + rows[i]._id + '">' + rows[i].name + '</option>';
            sel += '</select>';
            res.end(sel);
        } else {
            res.end(JSON.stringify('[]'));
            if (err)
                console.log(err);
        }
    });
});

app.post('/api/alert', function(req, res) {
    msg = {};
    if (!req.body.mission_id || !ObjectID.isValid(req.body.mission_id) || !req.body.api || !req.body.channel || !req.body.text) {
        res.end('ERR');
        return;
    }
    msg.user_id = 0;
    msg.analyst = '';
    msg.channel = req.body.channel;
    msg.text = xssFilters.inHTMLData(req.body.text);
    msg.timestamp = (new Date).getTime();
    mdb.collection('users').findOne({ api: req.body.api, deleted: { $ne: true } }, function(err, row) {
        if (row) {
            msg.user_id = row._id;
            msg.username = row.username;

            mdb.collection('missions').aggregate([
                {
                    $match: { _id: ObjectID(req.body.mission_id), 'mission_users.user_id': ObjectID(msg.user_id), deleted: { $ne: true } }
                },{
                    $unwind: '$mission_users'
                },{
                    $match: { 'mission_users.user_id': ObjectID(msg.user_id) }
                },{
                    $project: {
                        permissions: '$mission_users.permissions',
                    }
                }
            ]).toArray(function(err, row) { 
                if (row) {
                    if( hasPermission(row[0].permissions, 'api_access')) {
                        sendToRoom(req.body.mission_id, JSON.stringify({ act:'chat', arg: [msg] }));
                        res.end('OK');
                    }
                } else {
                     if (err)
                        console.log(err);
                    res.end('ERR');
                }
            });
        } else {
            if (err)
                console.log(err);
            res.end('ERR');
        }
    });
});

app.post('/api/:table', function (req, res) {
    if (!req.session.loggedin) {
        res.end('ERR4');
        return;
    }
    res.writeHead(200, {"Content-Type": "application/json"});
// MISSIONS
    if (req.params.table !== undefined && req.params.table === 'missions') {

        // get missions
        if (req.body.oper === undefined) {
            mdb.collection('missions').aggregate([
                {
                    $match: { deleted: { $ne: true }}
                },{
                    $lookup: {
                        from: 'users',
                        localField: 'user_id',
                        foreignField: '_id',
                        as: 'username'
                    },
                },{
                    $project: {
                        _id: 1,
                        name: 1,
                        start_date: 1,
                        username: '$username.username'
                    }
                }
            ]).toArray(function(err, rows) {
                if (rows) {
                    res.end(JSON.stringify(rows))
                } else {
                    res.end(JSON.stringify('[]'));
                    if (err)
                        console.log(err);
                }
            });

        // edit mission
        } else if (req.body.oper === 'edit' && hasPermission(req.session.cop_permissions, 'manage_missions') && req.body._id && req.body.name && req.body.start_date) {
            req.body.name = xssFilters.inHTMLData(req.body.name);
            if (req.body.analyst === undefined || req.body.analyst === '')
                req.body.analyst = req.session.user_id;
            else
                req.body.analyst = xssFilters.inHTMLData(req.body.analyst);
            var new_values = { $set: { name: req.body.name, start_date: req.body.start_date }};
            mdb.collection('missions').updateOne({ _id: ObjectID(req.body._id) }, new_values, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                } else {
                    res.end(JSON.stringify('ERR5'));
                    console.log(err);
                }
            });

        // add mission
        } else if (req.body.oper === 'add' && hasPermission(req.session.cop_permissions, 'manage_missions') && req.body.name && req.body.start_date) {
            req.body.name = xssFilters.inHTMLData(req.body.name);
            var mission = { name: req.body.name, start_date: req.body.start_date, user_id: ObjectID(req.session.user_id), mission_users: [], deleted: false };
            mission.mission_users[0] = { _id: ObjectID(null), user_id: ObjectID(req.session.user_id), permissions: ['all'], role: null };
            mdb.collection('missions').insertOne(mission, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                } else {
                    console.log(err);
                    res.end(JSON.stringify('ERR6'));
                }
            });

        // delete mission
        } else if (req.body.oper === 'del' && hasPermission(req.session.cop_permissions, 'delete_missions') && req.body._id !== undefined) {
            mdb.collection('missions').updateOne({ _id: ObjectID(req.body._id) }, { $set: { deleted: true } }, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                    //TODO: Also delete objects when they are mongo'ed
                } else {
                    console.log(err);
                    res.end(JSON.stringify('ERR17'));
                }
            });

        } else {
            res.end(JSON.stringify('ERR14'));
        }

// USERS
    } else if (req.params.table !== undefined && req.params.table === 'users' && hasPermission(req.session.cop_permissions, 'manage_users')) {
        // get users
        if (req.body.oper === undefined) {
            mdb.collection('users').find({ deleted: { $ne: true }}, { password: 0 }).toArray(function(err, rows) {
                if (rows) {
                    res.end(JSON.stringify(rows))
                } else {
                    res.end(JSON.stringify('[]'));
                    if (err)
                        console.log(err);
                }
            });

        // edit user
        } else if (req.body.oper !== undefined && req.body.oper === 'edit' && req.body.name !== undefined && req.body._id) {
            if (req.body.name === 'admin')
                req.body.permissions = 'all'; // make sure admin always has all permissions
            else {
                if (req.body.role === undefined || req.body.role === '')
                    req.body.role = null;
                var new_perms = [];
                req.body.permissions = req.body.permissions.split(',');
                for (var i = 0; i < req.body.permissions.length; i++) {
                    if (cop_permissions.indexOf(req.body.permissions[i]) > -1)
                        new_perms.push(req.body.permissions[i]);
                }
            }
            if (req.body.password !== '') {
                bcrypt.hash(req.body.password, null, null, function(err, hash) {
                    var new_values = { $set: { name: req.body.name, permissions: req.body.permissions, password: hash }};
                    mdb.collection('users').updateOne({ _id: ObjectID(req.body._id) }, new_values, function (err, result) {
                        if (!err) {
                            res.end(JSON.stringify('OK'));
                        } else {
                            res.end(JSON.stringify('ERR8'));
                            console.log(err);
                        }
                    });
                });
    
            // update user
            } else {
                var new_values = { $set: { name: req.body.name, permissions: req.body.permissions }};
                mdb.collection('users').updateOne({ _id: ObjectID(req.body._id) }, new_values, function (err, result) {
                    if (!err) {
                        res.end(JSON.stringify('OK'));
                    } else {
                        res.end(JSON.stringify('ERR9'));
                        console.log(err);
                    }
                });
            }

        // add user
        } else if (req.body.oper !== undefined && req.body.oper === 'add' && req.body.username && req.body.name !== undefined) {
            bcrypt.hash(req.body.password, null, null, function(err, hash) {
                if (!err) {
                    if (req.body.role === undefined || req.body.role === '')
                        req.body.role = null;
                    if (req.body.permissions === undefined || req.body.permissions === '')
                        req.body.permissions = null;
                    var api = crypto.randomBytes(32).toString('hex');
                    var user = { username: req.body.username, name: req.body.name, password: hash, permissions: req.body.permissions, api: api, avatar: '', deleted: false };
                    mdb.collection('users').insertOne(user, function (err, result) {
                        if (!err) {
                            res.end(JSON.stringify('OK'));
                        } else {
                            console.log(err);
                            res.end(JSON.stringify('ERR13'));
                        }
                    });
                } else
                    console.log(err);
            });

        // delete user
        } else if (req.body.oper !== undefined && req.body.oper === 'del' && req.body._id !== undefined) {
            if (req.body.name === 'admin') // don't delete admin
                res.end(JSON.stringify('ERR12'));
            else {
                mdb.collection('users').updateOne({ _id: ObjectID(req.body._id) }, { $set: { deleted: true } }, function (err, result) {
                    if (!err) {
                        res.end(JSON.stringify('OK'));
                    } else {
                        console.log(err);
                        res.end(JSON.stringify('ERR13'));
                    }
                });
            }
        } else {
            res.end(JSON.stringify('ERR14'));
        }

// ROLES
    } else if (req.params.table !== undefined && req.params.table === 'roles' && hasPermission(req.session.cop_permissions, 'manage_roles')) {
        // get roles
        if (req.body.oper === undefined) {

            mdb.collection('roles').aggregate([
                {
                    $match: { deleted: { $ne: true }}
                },{
                    $lookup: {
                        from: 'roles',
                        localField: 'sub_roles',
                        foreignField: '_id',
                        as: 'sub_role'
                    },
                },{
                    $project: {
                        _id: 1,
                        name: 1,
                        sub_roles:'$sub_role.name'
                    }
                }
            ]).toArray(function(err, rows) {
                if (rows) {
                    res.end(JSON.stringify(rows))
                } else {
                    res.end(JSON.stringify('[]'));
                    if (err)
                        console.log(err);
                }
            });

        // edit role
        } else if (req.body.oper !== undefined && req.body.oper === 'edit' && req.body.name && req.body._id) {
            req.body.name = xssFilters.inHTMLData(req.body.name);
            if (req.body.sub_roles)
                req.body.sub_roles = req.body.sub_roles.split(',').map(i => ObjectID(i));
            var new_values = { $set: { name: req.body.name, sub_roles: req.body.sub_roles }};
            mdb.collection('roles').updateOne({ _id: ObjectID(req.body._id) }, new_values, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                } else {
                    console.log(err);
                    res.end(JSON.stringify('ERR13'));
                }
            });

        // add role
        } else if (req.body.oper !== undefined && req.body.oper === 'add' && req.body.name) {
            req.body.name = xssFilters.inHTMLData(req.body.name);
            var role = { name: req.body.name, sub_roles: [], deleted: false };
            mdb.collection('roles').insertOne(role, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                } else {
                    console.log(err);
                    res.end(JSON.stringify('ERR19'));
                }
            });

        // delete role
        } else if (req.body.oper !== undefined && req.body.oper === 'del' && req.body._id !== undefined) {
            mdb.collection('roles').updateOne({ _id: ObjectID(req.body._id) }, { $set: { deleted: true } }, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                } else {
                    console.log(err);
                    res.end(JSON.stringify('ERR20'));
                }
            })
        } else {
            res.end(JSON.stringify('ERR21'));
        }

    // change password
    } else if (req.params.table !== undefined && req.params.table === 'change_password') {
        bcrypt.hash(req.body.newpass, null, null, function(err, hash) {
            mdb.collection('users').updateOne({ _id: ObjectID(req.session.user_id) }, { $set: { password: hash }}, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                } else {
                    res.end(JSON.stringify('ERR21'));
                    console.log(err);
                }
            });
        });

    } else {
        res.end(JSON.stringify('ERR22'));
    }
});

app.get('/config', function (req, res) {
    var profile = {};
    profile.username = req.session.username;
    profile.name = req.session.name;
    profile.user_id = req.session.user_id;
    profile.permissions = req.session.cop_permissions;
    if (req.session.loggedin) {
        res.render('config', { title: 'MCSCOP', profile: profile, permissions: req.session.cop_permissions});
    } else {
       res.redirect('login');
    }
});

function getPNGs(name) {
    return name.endsWith('.png');
}

app.get('/cop', function (req, res) {
    var icons = [];
    var shapes = [];
    var links = [];
    var mission_role = null;
    var mission_permissions = null;
    if (req.session.loggedin) {
        if (req.query.mission !== undefined && req.query.mission && ObjectID.isValid(req.query.mission)) {
            mdb.collection('missions').aggregate([
                {
                    $match: { _id: ObjectID(req.query.mission), 'mission_users.user_id': ObjectID(req.session.user_id), deleted: { $ne: true } }
                },{
                    $unwind: '$mission_users'
                },{
                    $match: { 'mission_users.user_id': ObjectID(req.session.user_id) }
                },{
                    $project: {
                        name: 1,
                        mission_role: 1,
                        permissions: '$mission_users.permissions',
                    }
                }
            ]).toArray(function(err, row) {
                if (row && row.length > 0) {
                    fs.readdir('./public/images/icons', function(err, icons) {
                        fs.readdir('./public/images/shapes', function(err, shapes) {
                            fs.readdir('./public/images/links', function(err, links) {
                                var mission_name = row[0].name;
                                if (req.session.username === 'admin')
                                    mission_permissions = ['all']; //admin has all permissions
                                else
                                    mission_permissions = row[0].permissions;
                                
                                req.session.mission_role[req.query.mission] = mission_role;
                                req.session.mission_permissions[req.query.mission] = mission_permissions;

                                if (req.session.username === 'admin' || (mission_permissions && mission_permissions !== '')) // always let admin in
                                    res.render('cop', { title: 'MCSCOP - ' + mission_name, role: mission_role, permissions: mission_permissions, mission_name: mission_name, user_id: req.session.user_id, username: req.session.username, icons: icons.filter(getPNGs), shapes: shapes.filter(getPNGs), links: links.filter(getPNGs)});
                                else
                                    res.redirect('login');
                            });
                        });
                    });
                } else {
                     res.redirect('login');
                     if (err)
                        console.log(err);
                }
            });
        } else {
            res.redirect('../');
        }
    } else {
       res.redirect('login');
    }
});

app.post('/login', function (req, res) {
    if (req.body.username !== undefined && req.body.username !== '' && req.body.password !== undefined && req.body.password !== '') {
        mdb.collection('users').findOne({ username: { $eq: req.body.username }}, function(err, row) {
            if (row) {
                bcrypt.compare(req.body.password, row.password, function(err, bres) {
                    if (bres) {
                        req.session.user_id = row._id;
                        req.session.name = row.name;
                        req.session.username = row.username;
                        req.session.loggedin = true;
                        req.session.role = row.role;
                        req.session.sub_roles = [];
                        req.session.cop_permissions = row.permissions;
                        req.session.mission_permissions = {};
                        req.session.mission_role = {};
                        req.session.mission_sub_roles = {};
                        res.redirect('login');
                    } else
                        res.render('login', { title: 'MCSCOP', message: 'Invalid username or password.' });
                });
            } else {
                if (err)
                    console.log(err);
                res.render('login', { title: 'MCSCOP', message: 'Invalid username or password.' });
            }
        });
    } else {
        res.render('login', { title: 'MCSCOP', message: 'Invalid username or password.' });
    }
});

app.get('/login', function (req, res) {
    if (req.session.loggedin)
        res.redirect('.');
    else
        res.render('login', { title: 'MCSCOP Login' });
});


// --------------------------------------- FILES ------------------------------------------

app.post('/dir/', function (req, res) {
    if (!req.session.loggedin) {
        res.end('ERR23');
        return;
    }
    var dir = req.body.id;
    var mission_id = req.body.mission_id;
    if (dir && mission_id && dir !== '#') {
        dir = path.normalize(dir).replace(/^(\.\.[\/\\])+/, '');
        dir = path.join(__dirname + '/mission-files/mission-' + mission_id, dir);
        var s = fs.statSync(dir);
        if (s.isDirectory()) {
            getDir(dir, mission_id, function(r) {
                res.send(r);
            })
        } else {
            res.status(404).send('Not found');
        }
    } else if (dir && mission_id) {
        dir = path.join(__dirname, '/mission-files/mission-' + mission_id);
        getDir(dir, mission_id, function(r) {
            res.send(r);
        });
    }
});

app.use('/download', express.static(path.join(__dirname, 'mission-files'), {
    etag: false,
    setHeaders: function(res, path) {
        res.attachment(path);
    }

}))

app.post('/mkdir', function (req, res) {
    if (!req.session.loggedin || !hasPermission(req.session.mission_permissions[req.body.mission_id], 'modify_files')) {
        res.end('ERR24');
        return;
    }
    var id = req.body.id;
    var name = req.body.name;
    var mission_id = req.body.mission_id;
    if (id && name && mission_id) {
        var dir = path.normalize(id).replace(/^(\.\.[\/\\])+/, '');
        name = path.normalize('/' + name + '/').replace(/^(\.\.[\/\\])+/, '');
        dir = path.join(path.join(path.join(__dirname, '/mission-files/mission-' + mission_id + '/'), dir), name);
        fs.stat(dir, function (err, s) {
            if (err == null)
                res.status(500).send('mkdir error');
            else if (err.code == 'ENOENT') {
                fs.mkdir(dir,function(err){
                    if(err)
                        res.status(500).send('mkdir error');
                    else {
                        res.send('{}');
                        sendToRoom(req.body.mission_id, JSON.stringify({act: 'update_files', arg: null}));
                    }
               });
            } else {
                res.status(500).send('mkdir error');
            }
        });
    } else
        res.status(404).send('Y U bein wierd?');
});

app.post('/mv', function (req, res) {
    if (!req.session.loggedin || !hasPermission(req.session.mission_permissions[req.body.mission_id], 'modify_files')) {
        res.end('ERR25');
        return;
    }
    var dst = req.body.dst;
    var src = req.body.src;
    var mission_id = req.body.mission_id;
    if (dst && src && mission_id) {
        var dstdir = path.normalize(dst).replace(/^(\.\.[\/\\])+/, '');
        var srcdir = path.normalize(src).replace(/^(\.\.[\/\\])+/, '');
        dstdir = path.join(path.join(__dirname, '/mission-files/mission-' + mission_id), dstdir);
        srcdir = path.join(path.join(__dirname, '/mission-files/mission-' + mission_id), srcdir);
        fs.stat(dstdir, function (err, s) {
            if (s.isDirectory()) {
                fs.stat(srcdir, function (err, s) {
                    if (s.isDirectory() || s.isFile()) {
                        fs.rename(srcdir, dstdir + '/' + path.basename(srcdir), function(err) {
                            if (err)
                                res.status(500).send('mv error');
                            else {
                                res.send('{}');
                                sendToRoom(req.body.mission_id, JSON.stringify({act: 'update_files', arg: null}));
                            }
                        });
                    } else
                        res.status(500).send('mv error');
                });
            } else
                res.status(500).send('mv error');
        });
    } else
        res.status(404).send('Y U bein wierd?');
});

app.post('/delete', function (req, res) {
    if (!req.session.loggedin || !hasPermission(req.session.mission_permissions[req.body.mission_id], 'modify_files')) {
        res.end('ERR26');
        return;
    }
    var id = req.body.id;
    var mission_id = req.body.mission_id;
    if (id) {
        var dir = path.normalize(id).replace(/^(\.\.[\/\\])+/, '');
        dir = path.join(path.join(__dirname, '/mission-files/mission-' + mission_id + '/'), dir);
        fs.stat(dir, function (err, s) {
            if (err)
                res.status(500).send('delete error');
            if (s.isDirectory()) {
                fs.rmdir(dir,function(err){
                    if(err)
                        res.status(500).send('delete error');
                    else {
                        res.send('{}');
                        sendToRoom(req.body.mission_id, JSON.stringify({act: 'update_files', arg: null}));
                    }
               });
            } else {
                fs.unlink(dir,function(err){
                    if(err)
                        res.status(500).send('delete error');
                    else {
                        res.send('{}');
                        sendToRoom(req.body.mission_id, JSON.stringify({act: 'update_files', arg: null}));
                    }
               });
            }
        });
    } else
        res.status(404).send('Y U bein wierd?');
});

app.post('/upload', upload.any(), function (req, res) {
    if (!req.session.loggedin || !hasPermission(req.session.mission_permissions[req.body.mission_id], 'modify_files')) {
        res.end('ERR27');
        return;
    }
    if (req.body.dir && req.body.dir.indexOf('_anchor') && req.body.mission_id) {
        var dir = req.body.dir.substring(0,req.body.dir.indexOf('_anchor'));
        dir = path.normalize(dir).replace(/^(\.\.[\/\\])+/, '');
        dir = path.join(__dirname + '/mission-files/mission-' + req.body.mission_id + '/', dir);
        async.each(req.files, function(file, callback) {
            fs.rename(file.path, dir + '/' + file.originalname, function(err) {
                if (err)
                    res.status(500).send('upload error');
                else
                    callback();
            });
        }, function() {
            res.send('{}');
            sendToRoom(req.body.mission_id, JSON.stringify({act: 'update_files', arg: null}));
        });
    } else
       res.status(404).send('Y U bein wierd?');
});

app.post('/avatar', upload.any(), function (req, res) {
    if (!req.session.loggedin || (!hasPermission(req.session.cop_permissions, 'modify_users') && req.session.user_id !== parseInt(req.body.id))) {
        res.end('ERR28');
        return;
    }
    if (req.body.id && !isNaN(req.body.id)) {
        var dir = path.join(__dirname + '/public/images/avatars/');
        async.each(req.files, function(file, callback) {
            fs.rename(file.path, dir + '/' + req.body.id + '.png', function(err) {
                if (err)
                    res.status(500).send('upload error');
                else
                    callback();
            });
        }, function() {
            mdb.collection('users').updateOne({ _id: ObjectID(req.body.id) }, { $set: { avatar: req.body.id + '.png' }}, function (err, result) {
                if (!err) {
                    res.end(JSON.stringify('OK'));
                } else {
                    res.end(JSON.stringify('ERR21'));
                    console.log(err);
                }
            });
        });
    } else
       res.status(404).send('Y U bein wierd?');
});

app.get("/images/avatars/*", function(req, res, next) {
    res.sendFile(path.join(__dirname, 'public/images/avatars/default.png'));
});

// -------------------------------------------------------------------------

http.listen(3000, function () {
    console.log('Server listening on port 3000!');
});
