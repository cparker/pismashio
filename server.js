'use strict'

const express = require('express')
const port = process.env.PORT || 5000
const app = express()
const bodyParser = require('body-parser')
const cookieParser = require('cookie-parser')
const server = require('http').createServer(app)
const io = require('socket.io')(server)

const cookieName = 'pismashioID'

const defaultHeight = 800
const defaultWidth = 900

/*
app.use(express.static(__dirname + '/node_modules'));  
app.get('/', function(req, res,next) {  
      res.sendFile(__dirname + '/index.html');
});

*/

let moveInterval
let moveIntervalPeriodMs = 5000
let moveItemCountMax = 5
let boardPieceMax = 20

let players = []
let playerConnections = []
let gameBoard = {
    boardPieces: [],
    level: -1
}

app.use(cookieParser())
app.use(express.static(__dirname + '/node_modules'))

// we need this explicit route so we can deal with cookies here
app.get('/', function(req, res, next) {
    if (!req.cookies[cookieName]) {
        console.log('this user has no cookie, so sad')
        res.cookie(cookieName, (new Date()).getTime())
    } else {
        console.log('this user has a cookie', req.cookies[cookieName])
    }

    res.sendFile(__dirname + '/index.html');
});
app.use(express.static('.'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({
    extended: true
}))


let getSmashID = (cookieHeader) => {
    return (() => {
        try {
            return (cookieHeader.split(';').find(x => x.indexOf(cookieName) != -1)).split('=')[1]
        } catch (e) {
            return null
        }
    })()
}


let generateGameBoard = (width, height, targetMax) => {
    let w = width || defaultWidth
    let h = height || defaultHeight
    let max = targetMax || 20

    // for a functional approach
    let boardPieces = []
    for (let i = 0; i < max; i++) {
        boardPieces.push(i)
    }

    boardPieces = boardPieces.map(b => {
        let x = Math.ceil((Math.random() * 1000)) % w
        let y = Math.ceil((Math.random() * 1000)) % h
        let randRotate = Math.ceil((Math.random() * 1000)) % 360

        return {
            id: `smashy-${b}`,
            x: x,
            y: y,
            rotate: randRotate,
            state: 'live'
        }
    })

    return {
        boardPieces: boardPieces,
        level: gameBoard.level + 1
    }
}


// interesting concurrency issues here ?
let handleHitItem = (client, playerSmashID) => {
    return (itemId) => {
        console.log(`player ${playerSmashID} hit item ${itemId}`)
        players = players.map(p => {
            if (p.playerId === playerSmashID) {
                p.score += 1
            }
            return p
        })
        let newBoardPieces = gameBoard.boardPieces.filter(b => b.id !== itemId)
        gameBoard = {
            boardPieces: newBoardPieces,
            level: gameBoard.level
        }
        console.log('board now has item count', gameBoard.boardPieces.length)
        if (gameBoard.boardPieces.length <= 0) {
            console.log('new board')
            // change the interval that controls pieces moving around
            moveIntervalPeriodMs = Math.max(moveIntervalPeriodMs - 800, 500)

            // also change the maximum number of items that can move
            moveItemCountMax = Math.min(moveItemCountMax += 3, 15)

            // and increase the number of items
            boardPieceMax = Math.min(boardPieceMax += 5, 40)

            gameBoard = generateGameBoard(undefined, undefined, boardPieceMax)

            // THIS client needs a new board too 
            client.emit('gameBoard', gameBoard)

            setMoveInterval(moveIntervalPeriodMs)
        }
        client.broadcast.emit('gameBoard', gameBoard)
        client.emit('playersUpdate', players)
        client.broadcast.emit('playersUpdate', players)
    }
}

// this basically just 'reflects' the message from a client to all other clients
let handlePlayerSmash = (client, playerSmashID) => {
    return (playerId) => {
        client.broadcast.emit('playerSmash', playerSmashID)
    }
}


/**
  let's move a few game pieces around
  
  SIDE EFFECT - directly updates the board
*/

let moveSomeItems = (width, height, maxItemsToMove) => {
    const w = width || defaultWidth
    const h = height || defaultHeight
    let piecesToMove = Math.min(Math.ceil((Math.random() * 1000)) % (maxItemsToMove || 5), gameBoard.boardPieces.length)

    let movedPieces = []
    for (let i = 0; i < piecesToMove; i++) {
        try {
            let x = Math.ceil((Math.random() * 1000)) % w
            let y = Math.ceil((Math.random() * 1000)) % h
            let rotate = Math.ceil((Math.random() * 1000)) % 360
            gameBoard.boardPieces[i].x = x
            gameBoard.boardPieces[i].y = y
            gameBoard.boardPieces[i].rotate = rotate
            movedPieces.push(gameBoard.boardPieces[i])
        } catch (e) {
            console.log('caught exception moving pieces... somebody prolly smashed one', e)
        }
    }
    
    return movedPieces
}


io.on('connection', client => {
    console.log('HEADERS', client.handshake.headers)
    const playerSmashID = getSmashID(client.handshake.headers.cookie)

    if (!playerSmashID) {
        console.log('could not get a playerSmashID?')
        return
    }


    client.on('hitItem', handleHitItem(client, playerSmashID))


    client.on('playerSmash', handlePlayerSmash(client, playerSmashID))


    client.on('join', data => {
        console.log(`player has joined, and their pismashioID is ${playerSmashID}`)

        if (players.length === 0) {
            console.log('no players yet, so generating a board')
            gameBoard = generateGameBoard()
        }

        if (players.find(p => p.playerId === playerSmashID)) {
            console.log('player is already registered')
        } else {
            console.log('registering new player', playerSmashID)

            // keep track of players
            players.push({
                playerId: playerSmashID,
                score: 0
            })

            // keep tack of players and their client connections separately
            // seems like we shouldn't have to do this ourselves?
            playerConnections.push({
                playerId: playerSmashID,
                client: client
            })

        }
        console.log('players now', players)

        // let the client know their ID (it's in the cookie THEY sent to US, so this feels weird)
        client.emit('registrationResponse', {
            playerId: playerSmashID,
            score: 0
        })

        // tell THIS client about all the players
        client.emit('playersUpdate', players)

        // tell THIS client about the game board
        client.emit('gameBoard', gameBoard)

        // then broadcast all the registered players to everyone BUT THIS one
        client.broadcast.emit('playersUpdate', players)
    })


    client.on('playerPosition', data => {
        //console.log('playerPosition', data)
        client.broadcast.emit('playerPositionUpdate', data)
    })


    client.on('setPlayerName', name => {
        console.log(`setting player ${playerSmashID} name to ${name}`)
        players = players.map(p => {
            if (p.playerId === playerSmashID) {
                p.name = name
            }
            return p
        })

        client.broadcast.emit('playersUpdate', players)
        client.emit('playersUpdate', players)
    })


    client.on('playerChat', chatMessage => {
        // add playerName, then reflect
        const foundPlayer = players.find(p => p.playerId === chatMessage.playerId)
        chatMessage.name = foundPlayer.name
        client.broadcast.emit('playerChat', chatMessage)
        client.emit('playerChat', chatMessage)
    })
})

io.on('disconnect', client => {
    console.log('disconnect', client.conn.id)
    let newPlayers = players.filter(p => p.socketId != client.conn.id)
    players = newPlayers

    client.broadcast.emit('playersUpdate', players)
})

let setMoveInterval = (period) => {
    if (moveInterval) {
        clearInterval(moveInterval)
    }

    moveInterval = setInterval(() => {
        if (gameBoard.level > 0) {
            const movedPieces = moveSomeItems(undefined, undefined, moveItemCountMax)
            playerConnections.forEach(con => {
                con.client.broadcast.emit('boardMoveItems', movedPieces)
                con.client.emit('boardMoveItems', movedPieces)
            })
        }
    }, period)

}

setMoveInterval(moveIntervalPeriodMs)

server.listen(port, '0.0.0.0', () => {
    console.log(`listening on ${port}`)
})