import {
  extractOpenapiData,
  openapiDataToFunctions
} from "@/lib/openapi-conversion"
import { checkApiKey, getServerProfile } from "@/lib/server/server-chat-helpers"
import { ChatSettings } from "@/types"
import { OpenAIStream, StreamingTextResponse } from "ai"
import { ServerRuntime } from "next"
import OpenAI from "openai"
import { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions.mjs"

export const runtime: ServerRuntime = "edge"

export async function POST(request: Request) {
  const json = await request.json()
  const {
    chatSettings,
    messages,
    toolSchemas,
    customHeaders,
    isRequestInBody
  } = json as {
    chatSettings: ChatSettings
    messages: any[]
    toolSchemas: string
    customHeaders: string
    isRequestInBody: boolean
  }

  try {
    const profile = await getServerProfile()

    checkApiKey(profile.openai_api_key, "OpenAI")

    const openai = new OpenAI({
      apiKey: profile.openai_api_key || "",
      organization: profile.openai_organization_id
    })

    let allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
    let allRouteMaps = {}
    let schemaDetails = []

    for (const schemaString of toolSchemas) {
      const convertedSchema = extractOpenapiData(schemaString)
      const tools = openapiDataToFunctions(convertedSchema) || []
      allTools = allTools.concat(tools)

      const routeMap = convertedSchema.routes.reduce(
        (map: Record<string, string>, route) => {
          route.methods.forEach(method => {
            map[route.path] = method.operationId
          })
          return map
        },
        {}
      )

      allRouteMaps = { ...allRouteMaps, ...routeMap }

      schemaDetails.push({
        title: convertedSchema.title,
        description: convertedSchema.description,
        url: convertedSchema.url,
        headers: customHeaders,
        routeMap
      })
    }

    const firstResponse = await openai.chat.completions.create({
      model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
      messages,
      tools: allTools
    })

    const message = firstResponse.choices[0].message
    messages.push(message)
    const toolCalls = message.tool_calls || []

    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const functionCall = toolCall.function
        const functionName = functionCall.name
        const parsedArgs = JSON.parse(toolCall.function.arguments)

        // Find the schema detail that contains the function name
        const schemaDetail = schemaDetails.find(detail =>
          Object.values(detail.routeMap).includes(functionName)
        )
        if (!schemaDetail) {
          throw new Error(`Function ${functionName} not found in any schema`)
        }

        const path = Object.keys(schemaDetail.routeMap).find(
          key => schemaDetail.routeMap[key] === functionName
        )
        if (!path) {
          throw new Error(`Path for function ${functionName} not found`)
        }

        // Decide with type of request to make
        let data = {}

        if (isRequestInBody) {
          // If the type is set to body
          let headers = {
            "Content-Type": "application/json"
          }

          // Check if custom headers are set
          if (customHeaders) {
            let parsedCustomHeaders = JSON.parse(customHeaders)

            headers = {
              ...headers,
              ...parsedCustomHeaders
            }
          }

          const fullUrl = schemaDetail.url + path

          const requestInit = {
            method: "POST",
            headers: headers,
            body: JSON.stringify(parsedArgs)
          }

          const response = await fetch(fullUrl, requestInit)
          data = await response.json()
        } else {
          // If the type is set to query
          const queryParams = new URLSearchParams(parsedArgs).toString()
          const fullUrl = schemaDetail.url + path + "?" + queryParams
          const response = await fetch(fullUrl)
          data = await response.json()
        }

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(data)
        })
      }
    }

    const secondResponse = await openai.chat.completions.create({
      model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
      messages,
      stream: true
    })

    const stream = OpenAIStream(secondResponse)

    return new StreamingTextResponse(stream)
  } catch (error: any) {
    const errorMessage = error.error?.message || "An unexpected error occurred"
    const errorCode = error.status || 500
    return new Response(JSON.stringify({ message: errorMessage }), {
      status: errorCode
    })
  }
}
