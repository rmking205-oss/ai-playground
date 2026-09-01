
require("dotenv").config();

const { MongoClient, ObjectId } = require("mongodb");
const express = require("express");
const Groq = require("groq-sdk");
const path = require("path");

const app = express();
const PORT = 3000;

const client = new MongoClient(process.env.MONGODB_URI);

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

app.use(express.json());


// ===============================
// SERVE FRONTEND
// ===============================

app.use(express.static(__dirname));


// ===============================
// CONSTANTS
// ===============================

const USER_ID = "6a9674426b44c1c31ba4f297";


// ===============================
// AI MODELS
// ===============================

const DEFAULT_MODEL = "openai/gpt-oss-20b";

const AVAILABLE_MODELS = [
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant"
];


// ===============================
// PRICING
// ===============================

// 1000 tokens = $0.01
const PRICE_PER_TOKEN = 0.01 / 1000;


// ===============================
// TOKEN LIMITS
// ===============================

const DEFAULT_MAX_TOKENS = 2000;

const MIN_MAX_TOKENS = 1;

const MAX_ALLOWED_TOKENS = 2000;


// ===============================
// TEMPERATURE
// ===============================

const DEFAULT_TEMPERATURE = 0.7;

const MIN_TEMPERATURE = 0;

const MAX_TEMPERATURE = 2;


// ===============================
// TOP P
// ===============================

const DEFAULT_TOP_P = 1;

const MIN_TOP_P = 0;

const MAX_TOP_P = 1;


// ===============================
// ACTIVE REQUESTS
// ===============================

// requestId -> request information

const activeRequests = new Map();


// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {

    res.sendFile(
        path.join(__dirname, "index.html")
    );

});


// ===============================
// AVAILABLE MODELS
// ===============================

app.get("/models", (req, res) => {

    res.json({

        success: true,

        models: AVAILABLE_MODELS

    });

});


// ===============================
// USERS
// ===============================

app.get("/users", async (req, res) => {

    try {

        const db = client.db("ai_playground");

        const users =
            await db.collection("users")
                .find()
                .toArray();

        res.json(users);

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


// ===============================
// LEDGER
// ===============================

app.get("/ledger", async (req, res) => {

    try {

        const db = client.db("ai_playground");

        const ledger =
            await db.collection("ledger")
                .find()
                .sort({ createdAt: -1 })
                .toArray();

        res.json(ledger);

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


// ===============================
// CHECK BALANCE
// ===============================

app.get("/check-balance", async (req, res) => {

    try {

        const db = client.db("ai_playground");

        const user =
            await db.collection("users").findOne({

                _id: new ObjectId(USER_ID)

            });

        if (!user) {

            return res.status(404).json({

                allowed: false,

                message: "User not found"

            });

        }

        const balance = Number(user.balance);

        res.json({

            allowed: balance > 0,

            balance: balance

        });

    } catch (error) {

        res.status(500).json({

            allowed: false,

            message: error.message

        });

    }

});


// ===============================
// RESERVE BALANCE
// ===============================

async function reserveBalance(
    userId,
    reservationCost,
    requestId,
    model
) {

    const session = client.startSession();

    try {

        session.startTransaction();

        const db = client.db("ai_playground");

        const users =
            db.collection("users");

        const ledger =
            db.collection("ledger");


        const user =
            await users.findOne(

                {
                    _id: new ObjectId(userId)
                },

                {
                    session
                }

            );


        if (!user) {

            throw new Error("User not found");

        }


        const balance =
            Number(user.balance);


        console.log(
            "Current balance:",
            balance
        );

        console.log(
            "Reservation:",
            reservationCost
        );


        if (balance < reservationCost) {

            throw new Error(
                "Insufficient balance"
            );

        }


        const updateResult =
            await users.updateOne(

                {

                    _id: new ObjectId(userId),

                    balance: {
                        $gte: reservationCost
                    }

                },

                {

                    $inc: {

                        balance: -reservationCost

                    }

                },

                {

                    session

                }

            );


        if (updateResult.modifiedCount !== 1) {

            throw new Error(
                "Balance changed. Please try again."
            );

        }


        await ledger.insertOne(

            {

                requestId: requestId,

                userId: userId,

                type: "ai_reservation",

                reservedCost: reservationCost,

                status: "reserved",

                model: model,

                createdAt: new Date()

            },

            {

                session

            }

        );


        await session.commitTransaction();


        console.log(
            "Balance reserved:",
            reservationCost
        );


    } catch (error) {

        await session.abortTransaction();

        throw error;

    } finally {

        await session.endSession();

    }

}


// ===============================
// FINALIZE NORMAL USAGE
// ===============================

async function finalizeUsage(
    userId,
    requestId,
    tokens,
    actualCost
) {

    const session = client.startSession();

    try {

        session.startTransaction();

        const db = client.db("ai_playground");

        const users =
            db.collection("users");

        const ledger =
            db.collection("ledger");


        const reservation =
            await ledger.findOne(

                {

                    requestId: requestId,

                    type: "ai_reservation",

                    status: "reserved"

                },

                {

                    session

                }

            );


        if (!reservation) {

            throw new Error(
                "Reservation not found or already processed"
            );

        }


        const reservedCost =
            Number(reservation.reservedCost);


        const refund =
            Math.max(
                0,
                reservedCost - actualCost
            );


        if (refund > 0) {

            await users.updateOne(

                {

                    _id: new ObjectId(userId)

                },

                {

                    $inc: {

                        balance: refund

                    }

                },

                {

                    session

                }

            );

        }


        await ledger.updateOne(

            {

                _id: reservation._id,

                status: "reserved"

            },

            {

                $set: {

                    status: "completed",

                    actualCost: actualCost,

                    tokens: tokens,

                    completedAt: new Date()

                }

            },

            {

                session

            }

        );


        await ledger.insertOne(

            {

                requestId: requestId,

                userId: userId,

                type: "ai_usage",

                tokens: tokens,

                cost: actualCost,

                model: reservation.model,

                createdAt: new Date()

            },

            {

                session

            }

        );


        await session.commitTransaction();


        console.log(
            "Actual cost:",
            actualCost
        );

        console.log(
            "Refund:",
            refund
        );


        return {

            actualCost,

            refund

        };


    } catch (error) {

        await session.abortTransaction();

        throw error;

    } finally {

        await session.endSession();

    }

}


// ===============================
// CANCEL RESERVATION
// ===============================

async function cancelReservation(
    userId,
    requestId,
    partialTokens = 0
) {

    const session = client.startSession();

    try {

        session.startTransaction();

        const db = client.db("ai_playground");

        const users =
            db.collection("users");

        const ledger =
            db.collection("ledger");


        const reservation =
            await ledger.findOne(

                {

                    requestId: requestId,

                    type: "ai_reservation",

                    status: "reserved"

                },

                {

                    session

                }

            );


        if (!reservation) {

            await session.commitTransaction();

            console.log(
                "Reservation already processed:",
                requestId
            );

            return;

        }


        const reservedCost =
            Number(reservation.reservedCost);


        partialTokens =
            Math.max(
                0,
                Math.floor(Number(partialTokens) || 0)
            );


        const actualCost =
            partialTokens *
            PRICE_PER_TOKEN;


        const refund =
            Math.max(
                0,
                reservedCost - actualCost
            );


        // ===============================
        // REFUND UNUSED BALANCE
        // ===============================

        if (refund > 0) {

            await users.updateOne(

                {

                    _id: new ObjectId(userId)

                },

                {

                    $inc: {

                        balance: refund

                    }

                },

                {

                    session

                }

            );

        }


        // ===============================
        // MARK RESERVATION CANCELLED
        // ===============================

        const updateResult =
            await ledger.updateOne(

                {

                    _id: reservation._id,

                    status: "reserved"

                },

                {

                    $set: {

                        status: "cancelled",

                        tokens: partialTokens,

                        actualCost: actualCost,

                        refund: refund,

                        cancelledAt: new Date()

                    }

                },

                {

                    session

                }

            );


        if (updateResult.modifiedCount !== 1) {

            throw new Error(
                "Reservation was already processed."
            );

        }


        // ===============================
        // SAVE PARTIAL USAGE
        // ===============================

        if (partialTokens > 0) {

            await ledger.insertOne(

                {

                    requestId: requestId,

                    userId: userId,

                    type: "ai_usage_cancelled",

                    tokens: partialTokens,

                    cost: actualCost,

                    model: reservation.model,

                    createdAt: new Date()

                },

                {

                    session

                }

            );

        }


        await session.commitTransaction();


        console.log(
            "Generation stopped."
        );

        console.log(
            "Partial tokens:",
            partialTokens
        );

        console.log(
            "Partial cost:",
            actualCost
        );

        console.log(
            "Refund:",
            refund
        );


    } catch (error) {

        await session.abortTransaction();

        throw error;

    } finally {

        await session.endSession();

    }

}


// ===============================
// AI CHAT STREAM
// ===============================

app.post("/api/chat", async (req, res) => {

    const question =
        req.body.question;


    if (!question) {

        return res.status(400).json({

            success: false,

            message: "Question is required"

        });

    }


    // ===============================
    // USER SETTINGS
    // ===============================

    const requestedModel =
        req.body.model ||
        DEFAULT_MODEL;


    const temperature =
        Number(
            req.body.temperature ??
            DEFAULT_TEMPERATURE
        );


    const top_p =
        Number(
            req.body.top_p ??
            DEFAULT_TOP_P
        );


    const requestedMaxTokens =
        Number(
            req.body.max_tokens ??
            DEFAULT_MAX_TOKENS
        );


    // ===============================
    // VALIDATION
    // ===============================

    if (!AVAILABLE_MODELS.includes(requestedModel)) {

        return res.status(400).json({

            success: false,

            message: "Invalid model"

        });

    }


    if (
        !Number.isFinite(temperature) ||
        temperature < MIN_TEMPERATURE ||
        temperature > MAX_TEMPERATURE
    ) {

        return res.status(400).json({

            success: false,

            message:
                "Temperature must be between 0 and 2"

        });

    }


    if (
        !Number.isFinite(top_p) ||
        top_p < MIN_TOP_P ||
        top_p > MAX_TOP_P
    ) {

        return res.status(400).json({

            success: false,

            message:
                "top_p must be between 0 and 1"

        });

    }


    if (
        !Number.isInteger(requestedMaxTokens) ||
        requestedMaxTokens < MIN_MAX_TOKENS ||
        requestedMaxTokens > MAX_ALLOWED_TOKENS
    ) {

        return res.status(400).json({

            success: false,

            message:
                "max_tokens must be between 1 and 2000"

        });

    }


    // ===============================
    // REQUEST VARIABLES
    // ===============================

    const requestId =
        new ObjectId().toString();


    let stopped = false;

    let fullAnswer = "";

    let billingFinished = false;


    try {

        console.log(
            "Request:",
            requestId
        );

        console.log(
            "Model:",
            requestedModel
        );

        console.log(
            "Temperature:",
            temperature
        );

        console.log(
            "Top P:",
            top_p
        );

        console.log(
            "Max Tokens:",
            requestedMaxTokens
        );


        // ===============================
        // RESERVATION COST
        // ===============================

        const reservationCost =
            requestedMaxTokens *
            PRICE_PER_TOKEN;


        console.log(
            "Reservation cost:",
            reservationCost
        );


        // ===============================
        // RESERVE BALANCE
        // ===============================

        await reserveBalance(

            USER_ID,

            reservationCost,

            requestId,

            requestedModel

        );


        console.log(
            "Balance approved."
        );


        // ===============================
        // ABORT CONTROLLER
        // ===============================

        const abortController =
            new AbortController();


        // ===============================
        // STORE REQUEST
        // ===============================

        activeRequests.set(

            requestId,

            {

                controller: abortController,

                stop: async () => {

                    if (stopped) {
                        return;
                    }

                    stopped = true;

                    console.log(
                        "STOP requested internally:",
                        requestId
                    );

                    abortController.abort();

                }

            }

        );


        // ===============================
        // SSE HEADERS
        // ===============================

        res.setHeader(
            "Content-Type",
            "text/event-stream"
        );

        res.setHeader(
            "Cache-Control",
            "no-cache"
        );

        res.setHeader(
            "Connection",
            "keep-alive"
        );

        res.flushHeaders();


        // ===============================
        // SEND START EVENT
        // ===============================

        res.write(

            `data: ${JSON.stringify({

                type: "start",

                requestId: requestId,

                model: requestedModel,

                temperature: temperature,

                top_p: top_p,

                max_tokens: requestedMaxTokens

            })}\n\n`

        );


        // ===============================
        // CLIENT DISCONNECT
        // ===============================

        req.on(
            "close",
            async () => {

                if (
                    !stopped &&
                    !billingFinished
                ) {

                    console.log(
                        "Client disconnected:",
                        requestId
                    );


                    stopped = true;


                    abortController.abort();


                    activeRequests.delete(
                        requestId
                    );


                    try {

                        const partialTokens =
                            Math.ceil(
                                fullAnswer.length / 4
                            );


                        await cancelReservation(

                            USER_ID,

                            requestId,

                            partialTokens

                        );


                        billingFinished = true;


                    } catch (error) {

                        console.error(

                            "Disconnect billing error:",

                            error.message

                        );

                    }

                }

            }
        );


        // ===============================
        // CALL GROQ
        // ===============================

        console.log(
            "Calling Groq..."
        );


        const stream =
            await groq.chat.completions.create(

                {

                    model: requestedModel,

                    messages: [

                        {

                            role: "system",

                            content: `
You are a helpful AI assistant.

Answer the user's question clearly,
naturally and simply.

Return only normal text.

Do not return JSON.
Do not use special structured fields.
`

                        },

                        {

                            role: "user",

                            content: question

                        }

                    ],

                    stream: true,

                    max_tokens:
                        requestedMaxTokens,

                    temperature:
                        temperature,

                    top_p:
                        top_p

                },

                {

                    signal:
                        abortController.signal

                }

            );


        // ===============================
        // STREAM CHUNKS
        // ===============================

        for await (
            const chunk
            of stream
        ) {

            if (stopped) {

                break;

            }


            const text =
                chunk
                    .choices[0]
                    ?.delta
                    ?.content || "";


            if (text) {

                fullAnswer += text;


                if (!res.writableEnded) {

                    res.write(

                        `data: ${JSON.stringify({

                            type: "chunk",

                            content: text

                        })}\n\n`

                    );

                }

            }

        }


        // ===============================
        // IF STOPPED
        // ===============================

        if (stopped) {

            const partialTokens =
                Math.ceil(
                    fullAnswer.length / 4
                );


            if (!billingFinished) {

                console.log(
                    "Generation stopped before completion."
                );

                console.log(
                    "Partial tokens:",
                    partialTokens
                );


                await cancelReservation(

                    USER_ID,

                    requestId,

                    partialTokens

                );


                billingFinished = true;

            }


            if (!res.writableEnded) {

                res.write(

                    `data: ${JSON.stringify({

                        type: "stopped",

                        success: true,

                        requestId: requestId,

                        tokens: partialTokens,

                        partialResponse: fullAnswer

                    })}\n\n`

                );

                res.end();

            }


            return;

        }


        // ===============================
        // CALCULATE TOKENS
        // ===============================

        const tokens =
            Math.ceil(
                fullAnswer.length / 4
            );


        const actualCost =
            tokens *
            PRICE_PER_TOKEN;


        console.log(
            "Generated tokens:",
            tokens
        );

        console.log(
            "Actual cost:",
            actualCost
        );


        // ===============================
        // FINALIZE BILLING
        // ===============================

        await finalizeUsage(

            USER_ID,

            requestId,

            tokens,

            actualCost

        );


        billingFinished = true;


        // ===============================
        // FINAL EVENT
        // ===============================

        if (!res.writableEnded) {

            res.write(

                `data: ${JSON.stringify({

                    type: "done",

                    success: true,

                    requestId: requestId,

                    question: question,

                    tokens: tokens,

                    cost: actualCost,

                    model: requestedModel,

                    temperature: temperature,

                    top_p: top_p,

                    max_tokens:
                        requestedMaxTokens

                })}\n\n`

            );

            res.end();

        }


    } catch (error) {


        // ===============================
        // ABORT / STOP ERROR
        // ===============================

        if (

            error.name === "AbortError" ||

            error.message?.toLowerCase()
                .includes("aborted")

        ) {


            console.log(
                "AI request aborted:",
                requestId
            );


            const partialTokens =
                Math.ceil(
                    fullAnswer.length / 4
                );


            if (!billingFinished) {

                try {

                    await cancelReservation(

                        USER_ID,

                        requestId,

                        partialTokens

                    );

                    billingFinished = true;


                } catch (cancelError) {

                    console.error(

                        "Abort billing error:",

                        cancelError.message

                    );

                }

            }


            if (!res.writableEnded) {

                res.write(

                    `data: ${JSON.stringify({

                        type: "stopped",

                        success: true,

                        requestId: requestId,

                        tokens: partialTokens,

                        partialResponse: fullAnswer

                    })}\n\n`

                );

                res.end();

            }


            return;

        }


        // ===============================
        // NORMAL ERROR
        // ===============================

        console.error(
            "AI Error:",
            error
        );


        if (!billingFinished) {

            try {

                await cancelReservation(

                    USER_ID,

                    requestId,

                    Math.ceil(
                        fullAnswer.length / 4
                    )

                );

                billingFinished = true;


            } catch (cancelError) {

                console.error(

                    "Refund error:",

                    cancelError.message

                );

            }

        }


        if (!res.headersSent) {

            return res.status(400).json({

                success: false,

                message: error.message

            });

        }


        if (!res.writableEnded) {

            res.write(

                `data: ${JSON.stringify({

                    type: "error",

                    message: error.message

                })}\n\n`

            );

            res.end();

        }


    } finally {

        activeRequests.delete(
            requestId
        );

    }

});


// ===============================
// STOP GENERATION
// ===============================

app.post(
    "/api/chat/stop",
    async (req, res) => {

        try {

            const requestId =
                req.body.requestId;


            if (!requestId) {

                return res.status(400).json({

                    success: false,

                    message:
                        "requestId is required"

                });

            }


            const request =
                activeRequests.get(
                    requestId
                );


            if (!request) {

                return res.json({

                    success: true,

                    message:
                        "Request already finished or stopped",

                    requestId:
                        requestId

                });

            }


            console.log(
                "STOP requested:",
                requestId
            );


            // ===============================
            // STOP REQUEST
            // ===============================

            await request.stop();


            res.json({

                success: true,

                message:
                    "Generation stopped",

                requestId:
                    requestId

            });


        } catch (error) {

            console.error(
                "Stop error:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    error.message

            });

        }

    }
);


// ===============================
// CONNECT DATABASE
// ===============================

async function connectDB() {

    await client.connect();


    console.log(
        "MongoDB connected successfully!"
    );


    const db =
        client.db("ai_playground");


    console.log(
        "Database:",
        db.databaseName
    );


    const users =
        await db.collection("users")
            .find()
            .toArray();


    const ledger =
        await db.collection("ledger")
            .find()
            .sort({
                createdAt: -1
            })
            .toArray();


    console.log(
        "Users:",
        users
    );


    console.log(
        "Ledger:",
        ledger
    );


    const user =
        await db.collection("users")

            .findOne({

                _id:
                    new ObjectId(USER_ID)

            });


    if (user) {

        console.log(

            "User balance:",

            Number(user.balance)

        );

    }

}


// ===============================
// START SERVER
// ===============================

connectDB()
    .then(() => {

        app.listen(

            PORT,

            () => {

                console.log(
                    `Server running on http://localhost:${PORT}`
                );

            }

        );

    })
    .catch((error) => {

        console.error(
            "Server startup error:",
            error
        );

    });