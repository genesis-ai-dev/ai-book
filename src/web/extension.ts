import * as vscode from "vscode"
import {
  MessageJSONSerializer,
  MessageJSONSerializerOptions,
} from "./MessageJSONSerializer"
import {
  ControllerFromRunner,
  appendContentToCell,
} from "./ControllerFromRunner"
import { MakeOpenAiRunner } from "./OpenAiRunner"

export const notebookType = "ai-translate"
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ai-translate.translateDocument",
      async (
        documentId: string | undefined,
        documentContent: [string] | undefined,
        cancellationToken: vscode.CancellationToken,
        preSelectedTranslationLanguage: string | undefined,
      ) => {
        if (!documentId) {
          vscode.window.showErrorMessage("Document ID is required.")
          return
        }
        let translationLanguage = preSelectedTranslationLanguage
        if (!translationLanguage) {
          translationLanguage =
            (await vscode.window.showInputBox({
              prompt:
                "Enter the translation language (e.g., 'English' for English)",
              placeHolder: "English",
              value: "English",
            })) || "English"
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
              JSON.stringify({
                messages: [],
                parameters: {},
              }),
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
        // Open the newly created file
        const notebookDoc = await vscode.workspace.openNotebookDocument(
          filePath,
        )
        const notebookEditor = await vscode.window.showNotebookDocument(
          notebookDoc,
        )

        // Generate a new cell at the end of the notebook

        await vscode.commands.executeCommand(
          "notebook.cell.insertCodeCellBelow",
        )
        const cell = notebookEditor.notebook.cellAt(0)
        await vscode.commands.executeCommand(
          "notebook.cell.changeLanguage",
          { start: cell.index, end: cell.index + 1 },
          "system",
        )
        await appendContentToCell({
          content: `You are a translator. \nYou will translate the content provided into ${
            translationLanguage ?? "a language to be specified later"
          } and return it as valid markdown. \nFirst explain potential difficulties one might encounter in translating the specific document given into the the translation language due to cultural and/or linguistic mismatches, then return the translation with the explanation of the specific difficulties, and then complete the translation. Explain the difficulties in the source language (e.g., English), and translate only in ${translationLanguage}`,
          cell: cell,
        })

        await vscode.commands.executeCommand(
          "notebook.cell.insertCodeCellBelow",
        )
        const contentCell = notebookEditor.notebook.cellAt(1)
        await vscode.commands.executeCommand(
          "notebook.cell.changeLanguage",
          { start: contentCell.index, end: contentCell.index + 1 },
          "user",
        )
        if (!documentContent) {
          return
        }
        for (const content of documentContent) {
          if (!content) {
            continue
          }
          const lastCell = notebookEditor.notebook.cellAt(
            notebookEditor.notebook.cellCount - 1,
          )
          await appendContentToCell({
            content: content,
            cell: lastCell,
          })
          await vscode.commands.executeCommand("notebook.execute", {
            start: lastCell.index,
            end: lastCell.index + 1,
          })
        }
      },
    ),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("ai-translate.translateFile", async () => {
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
            "ai-translate.translateDocument",
            documentId,
            documentContent.split("\n"),
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
    "ai-translate.configureParameters",
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
    "ai-translate.updateOpenAIKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        password: true,
        title: "Enter OpenAI API Key",
      })
      if (apiKey === undefined) {
        return
      }

      await context.secrets.store("ai-translate.openAI.apiKey", apiKey)
      return apiKey
    },
  )

  const notebookController = vscode.notebooks.createNotebookController(
    "ai-translate-openai",
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
