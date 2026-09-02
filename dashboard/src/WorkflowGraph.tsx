import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgents, toolColor, type Agent } from "./agents";
import NeuralNetMini from "./NeuralNetMini";
import { emitWorkflow as emitWorkflowFromBus, onWorkflow, type WorkflowEvent } from "./eventBus";
