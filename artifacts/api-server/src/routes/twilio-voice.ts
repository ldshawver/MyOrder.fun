import { Router, type IRouter, type Request, type Response } from "express";
import { buildForwardTwiML, logCallResult } from "../lib/luxitPhone";

const router: IRouter = Router();

function sendForwardTwiML(req: Request, res: Response, direction: "inbound" | "forward") {
  logCallResult({
    sid: typeof req.body?.CallSid === "string" ? req.body.CallSid : null,
    status: typeof req.body?.CallStatus === "string" ? req.body.CallStatus : "forwarding",
    from: typeof req.body?.From === "string" ? req.body.From : null,
    to: process.env.CALL_FORWARD_TO,
    direction,
  });
  res.type("text/xml").status(200).send(buildForwardTwiML({}));
}

router.post("/twilio/voice/inbound", (req, res) => {
  // PHONE_ALWAYS_FORWARD=true bypasses any future business-hours logic. The
  // emergency fallback also forwards when that routing/config is unavailable.
  sendForwardTwiML(req, res, "inbound");
});

router.post("/twilio/voice/forward", (req, res) => {
  sendForwardTwiML(req, res, "forward");
});

router.post("/twilio/voice/status", (req, res) => {
  logCallResult({
    sid: typeof req.body?.CallSid === "string" ? req.body.CallSid : null,
    status: typeof req.body?.CallStatus === "string" ? req.body.CallStatus : "status",
    from: typeof req.body?.From === "string" ? req.body.From : null,
    to: typeof req.body?.To === "string" ? req.body.To : null,
    direction: "status",
  });
  res.status(204).send();
});

export default router;
