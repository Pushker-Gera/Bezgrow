export default function RejectedPage() {

    return (

        <div className="min-h-screen bg-black text-white flex items-center justify-center px-6">

            <div className="bg-red-950 border border-red-800 p-10 rounded-2xl text-center max-w-lg w-full">

                <h1 className="text-4xl font-bold mb-4 text-red-400">
                    Application Rejected
                </h1>

                <p className="text-neutral-300 text-lg leading-8">
                    Your access request was rejected by the admin.
                </p>

            </div>

        </div>

    )

}