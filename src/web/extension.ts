import * as vscode from "vscode"
import {
  MessageJSONSerializer,
  MessageJSONSerializerOptions,
  defaultSerializedNotebook,
} from "./MessageJSONSerializer"
import { ControllerFromRunner } from "./ControllerFromRunner"
import { MakeOpenAiRunner } from "./OpenAiRunner"

export const notebookType = "llm-book"
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "llm-book.translateDocument",
      async (
        documentId: string | undefined,
        documentContent: string | undefined,
        cancellationToken: vscode.CancellationToken,
      ) => {
        if (!documentId) {
          vscode.window.showErrorMessage("Document ID is required.")
          return
        }
        const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
        const fileName = `${documentId}-${timestamp}.llm`
        const workspaceFolder =
          vscode.workspace.workspaceFolders?.[0].uri.fsPath
        if (!workspaceFolder) {
          vscode.window.showErrorMessage("No workspace folder found.")
          return
        }
        const filePath = vscode.Uri.file(`${workspaceFolder}/${fileName}`)
        const notebook = await MessageJSONSerializer.deserializeNotebook(
          Uint8Array.from(
            new TextEncoder().encode(
              JSON.stringify(defaultSerializedNotebook(documentContent)),
            ),
          ),
          cancellationToken,
        )
        const notebookBuffer = await MessageJSONSerializer.serializeNotebook(
          notebook,
          cancellationToken,
        )
        await vscode.workspace.fs.writeFile(filePath, notebookBuffer)
        vscode.window.showInformationMessage(
          `New .llm file created: ${fileName}`,
        )
      },
    ),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("llm-book.translateFile", async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Select a file to translate",
        filters: {
          "Text Files": ["txt", "md"],
        },
      })
      if (fileUri && fileUri[0]) {
        console.log({ fileUri })
        try {
          const fileData = await vscode.workspace.fs.readFile(fileUri[0])
          const documentContent = new TextDecoder("utf-8").decode(fileData)
          console.log({ documentContent })
          const documentId = fileUri[0].path.split("/").pop()?.split(".")[0] // Extract file name as ID
          vscode.commands.executeCommand(
            "llm-book.translateDocument",
            documentId,
            documentContent,
          )
        } catch (error) {
          console.error(error)
        }
      } else {
        vscode.window.showInformationMessage("No file selected.")
      }
    }),
  )
  const notebookSerializer = vscode.workspace.registerNotebookSerializer(
    notebookType,
    MessageJSONSerializer,
    MessageJSONSerializerOptions,
  )

  const configureParametersCommand = vscode.commands.registerCommand(
    "llm-book.configureParameters",
    async function recurse(arg) {
      const activeNotebookUri = vscode.window.activeNotebookEditor?.notebook.uri
      const clickedNotebookUri: vscode.Uri | undefined =
        arg?.notebookEditor?.notebookUri ?? activeNotebookUri

      const notebook = vscode.workspace.notebookDocuments.find(
        (e) => e.uri.toString() === clickedNotebookUri?.toString(),
      )

      if (!notebook || notebook.notebookType !== notebookType) {
        console.error("No notebook found.", {
          active: vscode.window.activeNotebookEditor,
          arg: arg,
        })
        await vscode.window.showErrorMessage("No notebook found.")
        return
      }

      const meta: [string, string | number][] = Object.entries(
        notebook.metadata.parameters,
      )

      type OurQuickPick = { label: string; description?: string; value?: any }

      const newEntry: OurQuickPick = {
        label: "New Parameter...",
      }
      const existing: OurQuickPick[] = meta.map(([k, v]) => ({
        label: k,
        description: JSON.stringify(v),
        value: v,
      }))
      const title = "Configure LLM Parameters"
      const pick = await vscode.window.showQuickPick<OurQuickPick>(
        [...existing, newEntry],
        {
          title,
        },
      )
      if (!pick) {
        return
      }

      let key, value
      if (pick === newEntry) {
        key = await vscode.window.showInputBox({
          prompt: "Enter parameter name",
          title,
        })
        if (!key) {
          return
        }
      } else {
        key = pick.label
        value = pick.description
      }

      const tryJSON = (str: string) => {
        try {
          return JSON.parse(str)
        } catch {
          return undefined
        }
      }
      const loosyGoosyJSON = (v: string) => tryJSON(v) ?? tryJSON(`"${v}"`)

      const newValue = await vscode.window.showInputBox({
        prompt: "Enter `" + key + "` value",
        title,
        value,
        validateInput(v) {
          const parsed = loosyGoosyJSON(v)
          if (parsed === undefined) {
            return "Format nontrivial input as JSON"
          }
        },
      })
      if (newValue === undefined) {
        return
      }
      const parsed = loosyGoosyJSON(newValue)
      if (parsed === undefined) {
        return
      }
      const newParams = { parameters: { ...notebook.metadata.parameters } }
      const edit = new vscode.WorkspaceEdit()
      if (parsed === "") {
        delete newParams.parameters[key]
      } else {
        newParams.parameters[key] = parsed
      }

      edit.set(notebook.uri, [
        vscode.NotebookEdit.updateNotebookMetadata(newParams),
      ])

      await vscode.workspace.applyEdit(edit)

      recurse(arg)
    },
  )

  const updateOpenAiKeyCommand = vscode.commands.registerCommand(
    "llm-book.updateOpenAIKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        password: true,
        title: "Enter OpenAI API Key",
      })
      if (apiKey === undefined) {
        return
      }

      await context.secrets.store("ai-book.openAI.apiKey", apiKey)
      return apiKey
    },
  )

  const notebookController = vscode.notebooks.createNotebookController(
    "llm-book-openai",
    notebookType,
    "OpenAI",
    ControllerFromRunner(MakeOpenAiRunner(context)),
  )

  notebookController.supportedLanguages = ["system", "user", "assistant"]

  context.subscriptions.push(
    notebookSerializer,
    notebookController,
    updateOpenAiKeyCommand,
    configureParametersCommand,
  )
}

export function deactivate() {
  // pass
}
